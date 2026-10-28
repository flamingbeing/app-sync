// One source of truth (1.5.0): the version is package.json's, the entries are package.json's exports, and the file
// lists follow the import graph tools/modularity.mjs walks (static imports and literal import()). This writes the rest:
//   - VERSION in index.js and app.js, CORE_VERSION in update/register.js and update/sw-core.js
//   - FILES in index.js and files.json: index.js and every file it loads
//   - entries.json: each module entry (app, auth, sync, update, sync/firestore) and every file it loads
//   - package.json's "./<file>.js" exports: the src/ files of the public API (files.json), nothing else of src/
// and checks that package.json's "files" covers everything exported and loaded (a github: install is complete).
//   node tools/generate.mjs           write them
//   node tools/generate.mjs --check   only check (exits 1 on drift; CI runs this)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { graph, entriesOf } from './modularity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = v => JSON.stringify(v, null, 2) + '\n';

/** @returns {Record<string, string>} file -> its generated text */
export function generated() {
  const pkg = JSON.parse(read('package.json')), v = pkg.version, out = {};
  const set = (f, re, to) => {
    const src = out[f] ?? read(f);
    if (!re.test(src)) throw new Error(`${f}: no ${re} to fill in`);
    out[f] = src.replace(re, to);
  };
  set('index.js', /^export const VERSION = '[^']*';$/m, `export const VERSION = '${v}';`);
  set('app.js', /^export const VERSION = '[^']*';$/m, `export const VERSION = '${v}';`);
  for (const f of ['update/register.js', 'update/sw-core.js']) set(f, /CORE_VERSION = '[^']*'/, `CORE_VERSION = '${v}'`);

  const files = graph(ROOT, 'index.js');
  // FILES, wrapped as before (120 columns)
  const lines = [];
  let line = 'export const FILES = [';
  files.forEach((f, i) => {
    const item = `'${f}'` + (i < files.length - 1 ? ',' : '];');
    if (line.length + 1 + item.length > 120) { lines.push(line); line = '  ' + item; }
    else line += (line.endsWith('[') ? '' : ' ') + item;
  });
  lines.push(line);
  set('index.js', /^export const FILES = \[[\s\S]*?\];$/m, lines.join('\n'));
  out['files.json'] = json(files);

  const entries = Object.keys(entriesOf(ROOT));
  out['entries.json'] = json(Object.fromEntries(entries.map(e => [e.replace(/\.js$/, ''), graph(ROOT, e)])));

  // the src/ files of the public API, by file name (as the "./*" wildcard served them until 1.4.x)
  const exports = Object.fromEntries(Object.entries(pkg.exports).filter(([, t]) => !(typeof t === 'string' && t.startsWith('./src/'))));
  for (const f of files.filter(f => f.startsWith('src/'))) exports['./' + f.slice(4)] = './' + f;
  out['package.json'] = json({ ...pkg, exports });
  return out;
}

/** @returns {string[]} what package.json's "files" leaves out of a github: install */
export function missing() {
  const pkg = JSON.parse(read('package.json'));
  const covered = f => pkg.files.some(p => p.endsWith('/') ? f.startsWith(p) : f === p);
  const need = new Set(['files.json', 'entries.json']);
  for (const t of Object.values(pkg.exports)) {
    for (const f of (typeof t === 'string' ? [t] : Object.values(t))) need.add(f.slice(2));
  }
  for (const e of [...Object.keys(entriesOf(ROOT)), 'index.js']) graph(ROOT, e).forEach(f => need.add(f));
  return [...need].filter(f => f !== 'package.json' && !covered(f)).sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv[2] === '--check', stale = [];
  for (const [f, text] of Object.entries(generated())) {
    if (read(f) === text) continue;
    if (check) stale.push(f); else fs.writeFileSync(path.join(ROOT, f), text);
  }
  const gaps = missing();
  if (gaps.length) console.error(`generate: package.json "files" leaves out ${gaps.join(', ')}`);
  if (stale.length) console.error(`generate: stale ${stale.join(', ')}: run node tools/generate.mjs and commit`);
  if (gaps.length || stale.length) process.exit(1);
  console.log(check ? 'generate: up to date' : 'generate: written');
}
