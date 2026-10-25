// The modularity check (0.9.2; module-contract, README "Modules"). For each module entry and every file it loads:
//   1. side-effect-free on import: importing the entry touches no browser global (storage, network, DOM, timers);
//      the Firebase SDK and the rest load inside start()
//   2. no top-level await
//   3. no import of another module's entry (app.js, auth.js, sync.js, update.js or their main src/ file); shared
//      code under src/ is fine
//   4. new URL(x, import.meta.url) and import(x) only with a literal x (bundlers can follow them)
//   5. every relative import names its `.js` file
//   node tools/modularity.mjs            check this checkout (exits 1 on a problem)
// Needs TypeScript (a dev dependency) for the parse.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// entry -> that module's main file
export const ENTRIES = { 'app.js': 'src/runner.js', 'auth.js': 'src/auth.js', 'sync.js': 'src/module-sync.js', 'update.js': 'src/module-update.js' };
const GLOBALS = ['window', 'document', 'self', 'location', 'navigator', 'indexedDB', 'localStorage', 'sessionStorage', 'caches',
  'fetch', 'XMLHttpRequest', 'BroadcastChannel', 'addEventListener', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'];

function parse(root, file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
}
const literal = n => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
const isMetaUrl = n => !!n && ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.name.text === 'url';

// one file's static imports and its problems under rules 2, 4, 5
function scan(root, file) {
  const sf = parse(root, file), imports = [], problems = [];
  const at = n => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  for (const st of sf.statements) {
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier;
    if (!spec || !literal(spec)) continue;
    const s = /** @type {import('typescript').StringLiteral} */ (spec).text;
    if (!s.startsWith('.')) { problems.push(`${at(st)}: imports '${s}' (only the repo's own files)`); continue; }
    if (!s.endsWith('.js')) problems.push(`${at(st)}: '${s}' has no .js extension`);
    imports.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), s)));
  }
  const walk = (n, fnDepth) => {
    if (ts.isAwaitExpression(n) && fnDepth === 0) problems.push(`${at(n)}: top-level await`);
    if (ts.isForOfStatement(n) && n.awaitModifier && fnDepth === 0) problems.push(`${at(n)}: top-level await`);
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' && n.arguments?.length === 2 && isMetaUrl(n.arguments[1]) && !literal(n.arguments[0]))
      problems.push(`${at(n)}: new URL() without a literal path`);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && !literal(n.arguments[0]))
      problems.push(`${at(n)}: import() without a literal path`);
    const fn = ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n);
    n.forEachChild(c => walk(c, fnDepth + (fn ? 1 : 0)));
  };
  walk(sf, 0);
  return { imports, problems };
}

function graph(root, entry, problems) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!fs.existsSync(path.join(root, f))) { problems.push(`${f} is imported but missing`); continue; }
    const r = scan(root, f);
    problems.push(...r.problems);
    todo.push(...r.imports);
  }
  return [...seen].sort();
}

// rule 1: import the entry in a fresh Node with every browser global trapped
function touched(root, entry) {
  const code = `const hit = new Set(), stub = new Proxy(function () {}, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : stub, apply: () => stub, construct: () => stub });
for (const g of ${JSON.stringify(GLOBALS)}) Object.defineProperty(globalThis, g, { configurable: true, get() { hit.add(g); return stub; }, set() { hit.add(g); } });
await import(${JSON.stringify(pathToFileURL(path.join(root, entry)).href)});
process.stdout.write(JSON.stringify([...hit]));`;
  try { return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString() || '[]'); }
  catch (e) { return [`nothing (the import failed: ${String(e.stderr || e.message).split('\n').find(l => /Error/.test(l)) || 'error'})`]; }
}

/** @param {string} root @returns {Promise<string[]>} */
export async function checkModularity(root) {
  const problems = [];
  const mains = new Set(Object.values(ENTRIES));
  for (const [entry, main] of Object.entries(ENTRIES)) {
    const files = graph(root, entry, problems);
    for (const f of files) {
      if (f !== entry && (f in ENTRIES || f === 'index.js')) problems.push(`${entry} loads ${f}, another entry`);
      if (f !== main && mains.has(f)) {
        const by = files.find(g => g !== f && scan(root, g).imports.includes(f)) || entry;
        problems.push(`${by} imports ${f}, another module's main file (${entry})`);
      }
    }
    for (const g of touched(root, entry)) problems.push(`${entry} touches ${g} on import`);
  }
  graph(root, 'index.js', problems);   // the one-object API: rules 2, 4, 5 too
  return [...new Set(problems)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = await checkModularity(root);
  if (problems.length) { console.error(`modularity: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
  console.log(`modularity: ok (${Object.keys(ENTRIES).join(', ')})`);
}
