// The modularity check (0.9.2; module-contract, README "Modules"). For each module entry and every file it loads:
//   1. side-effect-free on import: importing the entry touches no browser global (storage, network, DOM, timers);
//      the Firebase SDK and the rest load inside start()
//   2. no top-level await
//   3. no import of another module's entry (app.js, auth.js, sync.js, update.js or their main src/ file); shared
//      code under src/ is fine
//   4. new URL(x, import.meta.url) and import(x) only with a literal x (bundlers can follow them)
//   5. every relative import (static or a literal import()) names its `.js` file; import() targets are checked too
//   (1.5.0) and every other .js file package.json exports, unless its "sideEffects" lists it (update/sw-core.js, a
//   service worker script)
//   node tools/modularity.mjs            check this checkout (exits 1 on a problem)
// Needs TypeScript (a dev dependency) for the parse.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

// entry -> that module's main file (1.5.0: read from package.json's exports, the one list: every export but '.' that is
// a .js file outside update/ and src/; its main file is the first file it imports). No exports: the four classic entries.
/** @param {string} root @returns {Record<string, string>} */
export function entriesOf(root) {
  const pkg = path.join(root, 'package.json');
  const exports = fs.existsSync(pkg) ? JSON.parse(fs.readFileSync(pkg, 'utf8')).exports : null;
  const files = exports
    ? Object.entries(exports)
      .map(([k, v]) => [k, typeof v === 'string' ? v : v.default]).filter(([k, v]) => k !== '.' && /\.js$/.test(v) && !/^\.\/(update|src)\//.test(v))
      .map(([, v]) => v.slice(2))
    : ['app.js', 'auth.js', 'sync.js', 'update.js'];
  return Object.fromEntries(files.map(f => [f, scan(root, f).imports[0]]));
}
const GLOBALS = ['window', 'document', 'self', 'location', 'navigator', 'indexedDB', 'localStorage', 'sessionStorage', 'caches',
  'fetch', 'XMLHttpRequest', 'BroadcastChannel', 'addEventListener', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame'];

function parse(root, file) {
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  return ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
}
const literal = n => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
const isMetaUrl = n => !!n && ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.name.text === 'url';

// one file's imports (static and literal import()) and its problems under rules 2, 4, 5
function scan(root, file) {
  const sf = parse(root, file), imports = [], problems = [];
  const at = n => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  // a static import or a literal import(): same rules, and its file joins the graph
  const follow = (n, s) => {
    if (!s.startsWith('.')) { problems.push(`${at(n)}: imports '${s}' (only the repo's own files)`); return; }
    if (!s.endsWith('.js')) problems.push(`${at(n)}: '${s}' has no .js extension`);
    imports.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), s)));
  };
  for (const st of sf.statements) {
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier;
    if (!spec || !literal(spec)) continue;
    follow(st, /** @type {import('typescript').StringLiteral} */ (spec).text);
  }
  const walk = (n, fnDepth) => {
    if (ts.isAwaitExpression(n) && fnDepth === 0) problems.push(`${at(n)}: top-level await`);
    if (ts.isForOfStatement(n) && n.awaitModifier && fnDepth === 0) problems.push(`${at(n)}: top-level await`);
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' && n.arguments?.length === 2 && isMetaUrl(n.arguments[1]) && !literal(n.arguments[0]))
      problems.push(`${at(n)}: new URL() without a literal path`);
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (!literal(n.arguments[0])) problems.push(`${at(n)}: import() without a literal path`);
      else follow(n, /** @type {import('typescript').StringLiteral} */ (n.arguments[0]).text);
    }
    const fn = ts.isFunctionLike(n) || ts.isClassStaticBlockDeclaration(n);
    n.forEachChild(c => walk(c, fnDepth + (fn ? 1 : 0)));
  };
  walk(sf, 0);
  return { imports, problems };
}

/** @param {string} root @param {string} entry @param {string[]} [problems] @returns {string[]} */
export function graph(root, entry, problems = []) {
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
  const problems = [], ENTRIES = entriesOf(root);
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
  // (1.5.0) package.json's "sideEffects" is true: every .js file it exports and does not list there touches nothing on import
  const pkg = path.join(root, 'package.json');
  const { exports, sideEffects = true } = fs.existsSync(pkg) ? JSON.parse(fs.readFileSync(pkg, 'utf8')) : {};
  if (exports) {
    if (sideEffects === true) problems.push('package.json has no "sideEffects" (false, or the files that have them)');
    const listed = Array.isArray(sideEffects) ? sideEffects.map(f => f.replace(/^\.\//, '')) : [];
    const files = Object.values(exports).map(v => (typeof v === 'string' ? v : v.default).slice(2)).filter(f => /\.js$/.test(f));
    for (const f of files.filter(f => !listed.includes(f) && !(f in ENTRIES)))
      for (const g of touched(root, f)) problems.push(`${f} touches ${g} on import (not in package.json "sideEffects")`);
  }
  return [...new Set(problems)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const problems = await checkModularity(root);
  if (problems.length) { console.error(`modularity: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
  console.log(`modularity: ok (${Object.keys(entriesOf(root)).join(', ')})`);
}
