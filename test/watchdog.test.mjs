// Run with: node test/watchdog.test.mjs
// The listener watchdog (src/watchdog.js), the status rules (src/status.js) and the storage guard (src/persist.js).
import assert from 'node:assert/strict';
import { decide, createWatchdog, CACHE_MS, FLAG_MS, STALE_MS, THROTTLE_MS, ESCALATE_MS, CYCLE_THROTTLE_MS } from '../src/watchdog.js';

const T = 1_000_000;
const base = { now: T, online: true, event: false, lastServerAt: T - 1000, openedAt: T - 60000, cacheSince: 0, flaggedSince: 0, lastRelisten: 0, lastCycle: 0, quiet: true };
const d = o => decide({ ...base, ...o });

// healthy: nothing to do, however long it has been quiet (a quiet dataset sends nothing for hours)
const R = why => ({ relisten: true, cycle: false, why }), C = why => ({ relisten: false, cycle: true, why }), NO = { relisten: false, cycle: false, why: '' };
assert.deepEqual(d({}), NO);
assert.deepEqual(d({ lastServerAt: T - 3 * 3600_000 }), NO, 'long quiet alone is not a sign (no event)');
// 'cache': a listener has shown only the phone's own copy for CACHE_MS while online
assert.deepEqual(d({ cacheSince: T - CACHE_MS + 1 }), NO);
assert.deepEqual(d({ cacheSince: T - CACHE_MS }), R('cache'));
assert.equal(d({ cacheSince: T - 60000, online: false }).relisten, false, 'never while the browser says it is offline');
// 'flagged': a document still flagged pending long after every write was acknowledged
assert.equal(d({ flaggedSince: T - FLAG_MS + 1 }).relisten, false);
assert.deepEqual(d({ flaggedSince: T - FLAG_MS }), R('flagged'));
// 'quiet': only at a moment the phone came back, and only if the server hasn't been heard for STALE_MS
assert.equal(d({ event: true }).relisten, false, 'came back, heard from the server a second ago: fine');
assert.deepEqual(d({ event: true, lastServerAt: T - STALE_MS }), R('quiet'));
assert.deepEqual(d({ event: true, lastServerAt: 0, openedAt: T - STALE_MS - 1 }), R('quiet'), 'never heard since it opened');
assert.equal(d({ event: true, lastServerAt: 0, openedAt: T - 2000 }).relisten, false, 'it only just started listening');
assert.equal(d({ event: false, lastServerAt: T - 5 * STALE_MS }).relisten, false, 'no event, no quiet rule');
assert.equal(d({ event: true, lastServerAt: T - 5 * STALE_MS, online: false }).relisten, false, 'offline: wait for online');
// throttle: once every THROTTLE_MS
assert.equal(d({ cacheSince: T - 60000, lastRelisten: T - THROTTLE_MS + 1, quiet: false }).relisten, false);
assert.equal(d({ cacheSince: T - 60000, lastRelisten: T - THROTTLE_MS, quiet: false }).relisten, true);
assert.equal(d({ event: true, lastServerAt: T - 60000, lastRelisten: T - 5000 }).relisten, false, 'events are throttled too');
// escalation: still stuck ESCALATE_MS after listening again, and every write acknowledged: restart the connection
const stuck = { flaggedSince: T - 20000 };
assert.deepEqual(d({ ...stuck, lastRelisten: T - ESCALATE_MS }), C('flagged'), 'listened again and still stuck: restart the connection');
assert.deepEqual(d({ ...stuck, lastRelisten: T - ESCALATE_MS + 1 }), NO, 'not yet (and the relisten throttle holds)');
assert.equal(d({ ...stuck, lastRelisten: T - ESCALATE_MS, quiet: false }).cycle, false, 'never restart with a write unacknowledged: it would be sent again, and an increment sent twice counts twice');
assert.deepEqual(d({ ...stuck, lastRelisten: T - ESCALATE_MS, lastCycle: T - CYCLE_THROTTLE_MS + 1 }), NO, 'at most one restart a minute');
assert.deepEqual(d({ ...stuck, lastRelisten: T - ESCALATE_MS, lastCycle: T - CYCLE_THROTTLE_MS }), C('flagged'));
assert.equal(d({ ...stuck, lastRelisten: T - ESCALATE_MS, online: false }).cycle, false, 'offline: nothing');
assert.deepEqual(d({ cacheSince: T - CACHE_MS, lastRelisten: T - 10000 }), C('cache'), 'the cache sign escalates too');
assert.deepEqual(d({ event: true, lastServerAt: 1, lastRelisten: T - 10000 }), NO, 'the quiet sign never restarts the connection');
// order of reasons: the cache sign first
assert.equal(d({ cacheSince: T - CACHE_MS, flaggedSince: T - FLAG_MS, event: true, lastServerAt: 1 }).why, 'cache');

// ---- createWatchdog: facts from snapshots, actions on the answer ----
import { syncStatus, attentionCount } from '../src/status.js';
import { persistGuard } from '../src/persist.js';
{
  let now = T, online = true, quiet = true;
  const did = [];
  const w = createWatchdog({ now: () => now, online: () => online, quiet: () => quiet, relisten: why => did.push('relisten:' + why), cycle: why => did.push('cycle:' + why) });
  w.heard({ fromCache: false });
  assert.equal(w.check().relisten, false); assert.equal(w.stale(), false);
  w.heard({ fromCache: true }); now += CACHE_MS;
  assert.deepEqual(w.check(), R('cache')); assert.equal(w.stale(), true, 'stale until the server is heard');
  now += ESCALATE_MS; quiet = false;
  assert.equal(w.check().cycle, false, 'a write in flight: never restart the connection');
  quiet = true;
  assert.deepEqual(w.check(), C('cache'));
  w.heard({ fromCache: false });
  assert.equal(w.stale(), false);
  assert.deepEqual(did, ['relisten:cache', 'cycle:cache']);
  // quiet: asked only at a wake moment
  now += THROTTLE_MS + STALE_MS;
  assert.equal(w.check().relisten, false);
  assert.deepEqual(w.event(), R('quiet'));
  online = false; now += THROTTLE_MS;
  assert.deepEqual(w.event(), NO, 'offline: nothing');
}

// ---- status rules ----
{
  const st = o => syncStatus(o).state;
  assert.equal(st({}), 'synced');
  assert.equal(st({ pending: 2 }), 'saving');
  assert.equal(st({ pending: 2, online: false }), 'offline');
  assert.equal(st({ unsent: 1 }), 'saving', 'a write outside the outbox is not "synced" until acknowledged');
  assert.equal(st({ pending: 1, persisted: false }), 'at-risk');
  assert.equal(st({ persisted: false }), 'synced', 'nothing waiting: not at risk');
  assert.equal(st({ stale: true }), 'stale');
  assert.equal(st({ pending: 1, stale: true }), 'saving');
  assert.deepEqual(syncStatus({ attention: 3, pending: 1, persisted: false, online: false }), { state: 'attention', count: 3 });
  assert.equal(attentionCount([{ state: 'failed' }, { state: 'conflict' }, { state: 'pending' }, { state: 'synced' }]), 2);
}

// ---- persistGuard ----
{
  assert.deepEqual(await persistGuard(undefined), { supported: false, persisted: false });
  assert.deepEqual(await persistGuard({ storage: { persisted: async () => true } }), { supported: true, persisted: true });
  let asked = 0;
  assert.deepEqual(await persistGuard({ storage: { persisted: async () => false, persist: async () => (asked++, true) } }), { supported: true, persisted: true });
  assert.equal(asked, 1);
  assert.deepEqual(await persistGuard({ storage: { persisted: async () => false, persist: async () => false } }), { supported: true, persisted: false });
  assert.deepEqual(await persistGuard({ storage: { persisted: async () => { throw new Error('blocked'); } } }), { supported: true, persisted: false });
}
console.log('watchdog tests passed');
