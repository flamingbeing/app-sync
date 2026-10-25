// The Vite check (0.9.2; README "Vite"): Vite is never needed to run app-sync, but a page built with `vite build` works.
//   node test/vite/build.mjs external   (a) @core/* and https:// imports stay external (loaded by URL, the import map)
//   node test/vite/build.mjs source     (b) @core/* aliased to this checkout's entries: the bundle has auth and sync,
//                                           and no update code or replaceRecord (the unused imports are shaken out);
//                                           of the sign-in methods (1.3.0) only the one named is in the entry chunk,
//                                           the others only in the chunks their SHAPES.md string names load
//   node test/vite/build.mjs package    (c) @core/* aliased to the installed package's exports (app-sync/<entry>,
//                                           installed from a git ref in node_modules); same rule as (b)
// Needs vite (dev dependency only). Exits 1 on a failed build or a broken rule.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../..');
const mode = process.argv[2] || 'external';
const out = path.join(HERE, 'dist-' + mode);
// a line from each module's code, to find it in a bundle
const MARK = { auth: 'createApp needs config.sdk', sync: 'sync needs', update: 'update needs register' };
// a line from each sign-in method (src/signin/); main.js names password() only
const METHOD = { password: 'password needs the email', emailLink: 'emailLink needs the email', passcode: 'passcode needs its url', anonymous: 'signInAnonymously' };

const alias = {
  external: [],
  source: [{ find: /^@core\/(app|auth|sync|update)$/, replacement: path.join(ROOT, '$1.js') }],
  package: [{ find: /^@core\/(app|auth|sync|update)$/, replacement: 'app-sync/$1' }],
}[mode];
if (!alias) { console.error(`vite: unknown mode ${mode}`); process.exit(1); }

await build({
  root: HERE, logLevel: 'warn', configFile: false,
  resolve: { alias },
  build: {
    outDir: out, emptyOutDir: true, minify: false, target: 'es2022',
    rollupOptions: { external: id => /^https:\/\//.test(id) || (mode === 'external' && /^@core\//.test(id)) },
  },
});

const chunks = fs.readdirSync(path.join(out, 'assets')).filter(f => f.endsWith('.js'));
const read = f => fs.readFileSync(path.join(out, 'assets', f), 'utf8');
const js = chunks.map(read).join('\n');
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const entry = read(chunks.find(f => html.includes('/assets/' + f)) || '');
const problems = [];
if (!html.includes('"importmap"')) problems.push('the import map is gone from the built page');
if (!/https:\/\/www\.gstatic\.com\/firebasejs\//.test(js)) problems.push('the https:// import was bundled, not kept external');
if (mode === 'external') {
  for (const m of ['app', 'auth', 'sync', 'update']) if (!js.includes(`"@core/${m}"`) && !js.includes(`'@core/${m}'`) && m !== 'update') problems.push(`@core/${m} is not external`);
  if (js.includes(MARK.sync) || js.includes(MARK.auth)) problems.push('engine code was bundled in external mode');
} else {
  if (!js.includes(MARK.auth)) problems.push('the runner is missing from the bundle');
  if (!js.includes(MARK.sync)) problems.push('the sync module is missing from the bundle');
  if (js.includes(MARK.update)) problems.push('update code is in a page that never uses it (not shaken out)');
  if (js.includes('replaceRecord')) problems.push('replaceRecord is in a page that never uses it (not shaken out)');
  if (/@core\//.test(js)) problems.push('an @core/ name was left unresolved');
  if (!entry.includes(METHOD.password)) problems.push('the sign-in method the page names is not in its entry chunk');
  for (const m of ['emailLink', 'passcode', 'anonymous']) {
    if (entry.includes(METHOD[m])) problems.push(`sign-in method ${m} is in the entry chunk of a page that never names it`);
    if (!js.includes(METHOD[m])) problems.push(`sign-in method ${m} has no chunk for its string name`);
  }
}
if (problems.length) { console.error(`vite (${mode}): ${problems.join('; ')}`); process.exit(1); }
console.log(`vite (${mode}): ok, ${(js.length / 1024).toFixed(1)} KiB of JS`);
