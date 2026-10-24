// Proof-reader: mechanical checks of every page and document, for mistakes no app test looks for. Run it any time
// (or from a weekly workflow that files the --md output as an issue): node tools/proofread.mjs
//   --live   also checks that the live addresses answer (needs the internet)
//   --md     prints the findings as Markdown (for the issue); exit code 1 when there are any
// Checks:
// 1. Each page (.html): lang, <title>, viewport, noindex, alt text on images, and that every link and file it points to
//    in this repo exists (including #anchors on the same page).
// 2. Each document (.md): links to files in this repo exist.
// 3. --live: every host in worker/routes.js SITES answers (2xx or a redirect).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const SKIP = /(^|\/)(\.git|node_modules|vendor|test|__|\.claude|\.agents)(\/|$)/;
const findings = [];
const add = (file, msg) => findings.push({ file, msg });

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) walk(rel, out); else out.push(rel);
  }
  return out;
}
const files = walk('');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

// a link or src inside the repo -> the repo path it points to (null for other sites, mail, data, script-built ones)
function target(from, ref) {
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\$\{|\{\{)/i.test(ref) || ref.includes('${')) return null;
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  let p = clean.startsWith('/') ? clean.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  try { p = decodeURIComponent(p); } catch (e) {}
  if (p.startsWith('..')) return { outside: true, p };
  if (p === '' || p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]+$/i.test(p) && exists(p + '/index.html')) p += '/index.html';
  return { p };
}

// ---- 1. pages
for (const f of files.filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const head = html.slice(0, 6000);
  if (!/<html[^>]*\slang=/i.test(head)) add(f, 'no `lang` on `<html>` (screen readers guess the language)');
  if (!/<title>[^<]+<\/title>/i.test(head)) add(f, 'no `<title>`');
  if (!/<meta[^>]+name=["']viewport/i.test(head)) add(f, 'no viewport `<meta>` (it would look tiny on a phone)');
  // index.html at the root may be a public landing page; everything else stays out of search engines
  if (f !== 'index.html' && !/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(head) && !/<meta[^>]+noindex[^>]+name=["']robots/i.test(head)) add(f, 'no `<meta name="robots" content="noindex, nofollow">` (every app page has one)');
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) if (!/\salt=/i.test(m[0])) add(f, `an image has no \`alt\`: \`${m[0].slice(0, 80)}\``);
  // apps that use the # part of the address for their own screens (#list, #new-dops) aren't checked for anchors
  const dir = path.posix.dirname(f);
  const routes = /hashchange|location\.hash/.test(html) || files.some(j => j.endsWith('.js') && path.posix.dirname(j).startsWith(dir === '.' ? '\0' : dir) && /hashchange|location\.hash/.test(fs.readFileSync(path.join(ROOT, j), 'utf8')));
  const ids = new Set([...html.matchAll(/\sid=["']([^"']+)["']/g)].map(m => m[1]));
  for (const m of html.matchAll(/\s(?:href|src)=["']([^"']+)["']/gi)) {
    const ref = m[1];
    if (/^#./.test(ref)) { if (!routes && !ids.has(decodeURIComponent(ref.slice(1))) && !/^#\/|^#[a-z]+=|^#(top)?$/.test(ref)) add(f, `link to \`${ref}\`, but nothing on the page has that id`); continue; }
    const t = target(f, ref);
    if (!t) continue;
    if (t.outside) add(f, `\`${ref}\` points outside the site`);
    else if (!exists(t.p)) add(f, `\`${ref}\` points to \`${t.p}\`, which doesn't exist`);
  }
}

// ---- 2. documents
for (const f of files.filter(f => f.endsWith('.md'))) {
  const md = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of md.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const t = target(f, m[1]);
    if (!t || t.outside) continue;
    // a document's link to a folder is fine when the folder exists
    if (!exists(t.p) && !exists(t.p.replace(/\/index\.html$/, ''))) add(f, `link to \`${m[1]}\`, which doesn't exist`);
  }
}

// ---- 3. live addresses
if (args.has('--live')) {
  const routes = path.join(ROOT, 'worker/routes.js');
  const { SITES } = fs.existsSync(routes) ? await import(pathToFileURL(routes)) : { SITES: {} };
  const LIVE = Object.entries(SITES).flatMap(([h, s]) => s.root ? [`https://${h}/`] : Object.keys(s.prefixes || {}).map(p => `https://${h}${p}`));
  for (const u of LIVE) {
    try {
      const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
      if (r.status >= 400) add(u, `answered ${r.status}`);
    } catch (e) { add(u, `didn't answer (${e.cause?.code || e.name})`); }
  }
}

// ---- report
if (args.has('--md')) {
  if (!findings.length) { console.log('Nothing found.'); process.exit(0); }
  const by = Map.groupBy ? Map.groupBy(findings, x => x.file) : findings.reduce((m, x) => m.set(x.file, [...(m.get(x.file) || []), x]), new Map());
  let out = `${findings.length} thing${findings.length === 1 ? '' : 's'} to fix, found by \`node tools/proofread.mjs\`. Fix them in one PR (title "Site: proof-read fixes") and close this issue; the next run opens a new one if anything is left.\n`;
  for (const [file, list] of by) out += `\n**${file}**\n` + list.map(x => `- [ ] ${x.msg}`).join('\n') + '\n';
  console.log(out);
  process.exit(1);
}
for (const x of findings) console.log(`${x.file}: ${x.msg}`);
console.log(findings.length ? `proofread: ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'proofread: ok');
process.exit(findings.length ? 1 : 0);
