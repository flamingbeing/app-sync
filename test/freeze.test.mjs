// 0.8.0 freeze prep: the lean public index, src/internal.js, the file manifest (FILES, files.json) and the
// stored-format promise (FORMATS.md). These names and values are what 1.0 freezes: a change here is a CHANGELOG line,
// and a change to a stored format is a 2.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as index from '../index.js';
import * as internal from '../src/internal.js';
import { createWriteQueue } from '../src/writes.js';
import { leaveEntry } from '../src/sync.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// the files a module loads, following static import / export-from statements (not JSDoc import() types)
function importGraph(entry) {
  const seen = new Set(), todo = [entry];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/gm)) todo.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return [...seen].sort();
}

// the promised public names (1.0 keeps these; 1.x only adds)
const PUBLIC = ['createApp', 'userOf', 'claimsBehind', 'createReport', 'REPORT_ENDPOINT', 'createOutbox', 'createOutboxRegistry',
  'REGISTRY_KEY', 'forgetDevice', 'leaveEntry', 'persistGuard', 'firestoreCache', 'cacheFailure', 'CACHE_KEY', 'CACHE_MODES',
  'syncStatus', 'attentionCount', 'createFirestoreBackend', 'createSyncHub', 'createWatchdog', 'replanOnWake', 'eachSettled',
  'SKEW', 'createWriteQueue', 'createStores', 'recordSignature', 'checkWrite', 'mergeFields', 'mergeHeld', 'describeConflict',
  'resolvedRecord', 'pathOf', 'JOB_FORMAT', 'JOB_STATES', 'FILES', 'VERSION'];

test('FILES lists exactly the files index.js loads, and files.json says the same', () => {
  assert.deepEqual([...index.FILES].sort(), importGraph('index.js'));
  assert.deepEqual(JSON.parse(read('files.json')), index.FILES);
  for (const f of index.FILES) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('index.js names the promised public API; engine internals load from src/internal.js', () => {
  const src = read('index.js');
  // the names index.js exports by name (the `export *` from internal.js is the deprecated alias set, gone in 1.0)
  const named = [...src.matchAll(/^export (?:const (\w+)|\{([^}]+)\})/gm)].flatMap(m => m[1] ? [m[1]] : m[2].split(',').map(s => s.trim().split(/\s+as\s+/).pop()));
  assert.deepEqual([...named].sort(), [...PUBLIC].sort());
  for (const name of PUBLIC) assert.ok(name in index, name);
  for (const name of Object.keys(internal)) assert.ok(!PUBLIC.includes(name), `${name} is public and internal`);
  for (const name of ['plan', 'applyChanges', 'createCollectionSync', 'planServer', 'decide', 'watchSaved', 'buildReport', 'GRACE', 'SEND_TIMEOUT'])
    assert.equal(typeof internal[name] === 'undefined', false, `internal.js exports ${name}`);
  // 0.8.x: every moved name still loads from index.js, the same value (removed in 1.0)
  for (const [name, value] of Object.entries(internal)) assert.equal(index[name], value, name);
});

test('stored formats: keys, prefixes, job states and the job format number are the promised ones', async () => {
  assert.equal(index.REGISTRY_KEY, 'app-sync:outboxes');
  assert.equal(index.CACHE_KEY, 'app-sync-cache');
  assert.equal(index.JOB_FORMAT, 1);
  assert.deepEqual([...index.JOB_STATES], ['pending', 'synced', 'failed', 'conflict', 'archived']);
  const app = read('src/core.js');   // (0.9.1: the sync core, shared by createApp and the sync module)
  assert.match(app, /prefix: name \+ '-sync:'/, 'device copy prefix <name>-sync:');
  assert.match(app, /name \+ '-outbox'/, 'outbox name <name>-outbox');
  assert.match(read('src/registry.js'), /new Set\(\['synced', 'archived'\]\)/, 'finished states other apps on the origin read');
  const fsrc = read('src/firestore.js');
  assert.match(fsrc, /field: stampField = 'updatedAt'/);
  assert.match(fsrc, /serverField = 'serverAt'/);
  assert.deepEqual(leaveEntry('item', { id: 'r1', updatedAt: 5 }, 10), { id: 'item:r1', kind: 'item', data: { id: 'r1', updatedAt: 5 }, deletedAt: 10 });
});

test('every new job carries the job format number', async () => {
  const jobs = new Map();
  const store = { async put(x) { jobs.set(x.key, structuredClone(x)); }, async list(o) { return [...jobs.values()].filter(x => x.owner === o); },
    async get(k) { return jobs.get(k) ?? null; }, async remove(k) { jobs.delete(k); }, async forget() { jobs.clear(); } };
  const queue = createWriteQueue({ store, getOwner: () => 'a', online: () => false, backend: async (_o, _k, r) => r, delay: () => new Promise(r => setTimeout(r, 5)) });
  await queue.save('item', 'a', { id: '1', n: 1 });
  await queue.save('item', 'a', { id: '2', n: 1 });
  assert.equal(jobs.size, 2);
  for (const job of jobs.values()) {
    assert.equal(job.v, index.JOB_FORMAT);
    assert.ok(index.JOB_STATES.includes(job.state));
  }
});

// 0.9.3 (additive): a modules-only app imports only the entries, so what it needs from index.js is there too.
test("the entries carry what a modules-only app needs: app.js VERSION (= index.js's), sync.js leaveEntry (index.js's)", async () => {
  const app = await import('../app.js'), sync = await import('../sync.js');
  assert.equal(app.VERSION, index.VERSION);
  assert.equal(sync.leaveEntry, index.leaveEntry);
  assert.deepEqual(Object.keys(app).sort(), ['VERSION', 'createApp']);
  assert.deepEqual(Object.keys(sync).sort(), ['leaveEntry', 'sync']);
  assert.match(read('types/app.d.ts'), /export const VERSION: "/);
  assert.match(read('types/sync.d.ts'), /leaveEntry/);
});
