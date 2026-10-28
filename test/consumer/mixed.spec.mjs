// Mixed versions on one account (the consumer job copies this into app-starter's e2e/ and runs it there): one phone
// on the engine the starter pins (PINNED_SYNC_DIR, a checkout of that tag), one on the candidate (serve-candidate's
// preload), one emulator. Adds, edits and deletes cross both ways, so stored formats written by either version read
// on the other. Each phone checks the engine VERSION it really ran.
import { test, expect, signIn, signInAgain, add, uniq } from './fixtures.mjs';
import fs from 'node:fs';
import path from 'node:path';

const PINNED = process.env.PINNED_SYNC_DIR ? path.resolve(process.env.PINNED_SYNC_DIR) : '';
const CANDIDATE = process.env.SERVE_CANDIDATE_VERSION;
const versionIn = dir => fs.readFileSync(path.join(dir, 'index.js'), 'utf8').match(/export const VERSION = '([^']+)'/)[1];

async function phone(browser, dir) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // registered after the preload's route, so it wins for this phone
  if (dir) await context.route(/^https:\/\/core\.anawj\.com\/sync\/[^/]+\/(.+)$/, route => {
    const file = path.join(dir, new URL(route.request().url()).pathname.split('/').slice(3).join('/'));
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'not in PINNED_SYNC_DIR' });
    return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(file) });
  });
  return { context, page: await context.newPage() };
}
// the engine entry the page loaded: index.js, or app.js on a modules-only page (VERSION there from 0.9.3)
const ran = page => page.evaluate(async () => {
  const url = performance.getEntriesByType('resource').map(e => e.name).find(n => /^https:\/\/core\.anawj\.com\/sync\/[^/]+\/(index|app)\.js$/.test(n));
  return url ? (await import(url)).VERSION : null;
});
async function edit(page, from, to) {
  await page.getByRole('button', { name: from }).click();
  await page.fill('#edit-text', to);
  await page.click('#edit-save');
}
async function remove(page, text) {
  await page.getByRole('button', { name: text }).click();
  await page.click('#edit-delete');
  // the starter's confirm (app-starter #14) until it became delete-with-undo: click it only if it shows
  const confirm = page.locator('dialog.modal').getByRole('button', { name: 'Delete', exact: true });
  if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) await confirm.click();
}

test('a phone on the pinned engine and a phone on the candidate share one account', async ({ browser }) => {
  test.skip(!PINNED || !CANDIDATE, 'needs PINNED_SYNC_DIR and SERVE_CANDIDATE_VERSION');
  const old = await phone(browser, PINNED), cand = await phone(browser, '');
  try {
    const { email } = await signIn(old.page, 'member');
    await signInAgain(cand.page, email);
    expect(await ran(old.page), 'pinned phone runs the pinned engine').toBe(versionIn(PINNED));
    expect(await ran(cand.page), 'candidate phone runs the candidate').toBe(CANDIDATE);

    const a = uniq('old'), b = uniq('new');
    await add(old.page, a);
    await expect(cand.page.locator('#items')).toContainText(a, { timeout: 15_000 });
    await add(cand.page, b);
    await expect(old.page.locator('#items')).toContainText(b, { timeout: 15_000 });

    await edit(cand.page, a, a + ' edited');
    await expect(old.page.locator('#items')).toContainText(a + ' edited', { timeout: 15_000 });
    await edit(old.page, b, b + ' edited');
    await expect(cand.page.locator('#items')).toContainText(b + ' edited', { timeout: 15_000 });

    await remove(old.page, a + ' edited');
    await expect(cand.page.locator('#items')).not.toContainText(a, { timeout: 15_000 });
    await remove(cand.page, b + ' edited');
    await expect(old.page.locator('#items')).not.toContainText(b, { timeout: 15_000 });
  } finally {
    await old.context.close();
    await cand.context.close();
  }
});
