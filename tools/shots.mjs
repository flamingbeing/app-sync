// Phone screenshots of pages, for checking a visual change by hand (one viewport-sized shot is usually enough).
//   node tools/shots.mjs pages <base-ref>                   which pages to show: one per app folder changed since <base-ref>
//   node tools/shots.mjs shoot <url> <out-dir> <name> <path>…   390 × 844 screenshots of <url><path> as <name>-<i>.jpg
// Serve a checkout first (python3 -m http.server 8000) so apps open with made-up demo data, then shoot
// http://localhost:8000. Needs Playwright (PLAYWRIGHT_PATH / CHROMIUM_PATH point at a preinstalled one).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// the page to show for changes in a folder, when it isn't just /<folder>/ (e.g. an app's demo mode)
export const PAGES = { 'example/': '/example/' };
const MAX = 6;
// files that never change what a page shows: notes, tests, local tools, the Worker
const UNSEEN = /(\.md$|(^|\/)(test|tools|worker)\/)/;

export function pagesFor(files, exists = f => fs.existsSync(f)) {
  const out = [];
  for (const f of files.filter(f => !UNSEEN.test(f))) {
    const key = Object.keys(PAGES).find(k => f.startsWith(k));
    const top = f.includes('/') ? f.slice(0, f.indexOf('/') + 1) : null;
    const page = key ? PAGES[key] : top && exists(top + 'index.html') ? '/' + top : f === 'index.html' ? '/' : null;
    if (page && !out.includes(page)) out.push(page);
  }
  return out.slice(0, MAX);
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'pages') {
  const files = execFileSync('git', ['diff', '--name-only', `${args[0]}...HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  console.log(JSON.stringify(pagesFor(files)));
} else if (mode === 'shoot') {
  const [url, dir, name, ...paths] = args;
  const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
  fs.mkdirSync(dir, { recursive: true });
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
  const results = [];
  for (const [i, p] of paths.entries()) {
    const page = await ctx.newPage();
    let status = 0;
    try {
      const res = await page.goto(url + p, { waitUntil: 'load', timeout: 30000 });
      status = res ? res.status() : 0;
      await page.waitForTimeout(1500); // apps draw after load
      if (status === 200) await page.screenshot({ path: path.join(dir, `${name}-${i}.jpg`), type: 'jpeg', quality: 70 });
    } catch (e) { status = -1; }
    results.push({ path: p, status });
    await page.close();
  }
  await b.close();
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(results));
  console.log(`${name}: ${results.map(r => `${r.path} ${r.status}`).join(', ')}`);
} else if (mode === undefined || mode === '--help') {
  console.log('usage: node tools/shots.mjs pages <base-ref> | shoot <url> <out-dir> <name> <path>…');
} else {
  console.error('usage: node tools/shots.mjs pages <base-ref> | shoot <url> <out-dir> <name> <path>…');
  process.exit(2);
}
