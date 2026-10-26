// The sync engine: opening an app costs about one read per collection when nothing changed.
//
// Each collection has a local copy on this device (store.js). On start the engine shows that copy at once, then
// listens only for documents changed since the last sync:
//   query(collection, where('updatedAt', '>', lastSync - SKEW))
// and merges what arrives. The first time on a device, and once a week after that, it reads the whole collection
// instead, which also picks up documents without updatedAt and heals anything the deltas missed. A page left open
// past that week reads in full again when it wakes (replan: the page shown again, or back online).
// Deletions: tombstones from a recycle bin collection (entries { kind, data, deletedAt }) arrive the same way and
// remove the binned record here, unless the record was changed after the version that was binned (restored, or the
// delete was refused as a conflict). A record the server removes while it is in view goes at once; one removed while
// this device's own write was pending (a refused write) is checked with one read.
//
// lastSync is this device's clock when the server last confirmed the list; SKEW covers writers whose clocks are a
// little behind. Documents stamped after the newest one held here are read too (a reader whose clock ran ahead at its
// last sync would otherwise skip what others wrote since); the bin feed keeps the newest deletedAt it has seen for
// the same reason. Writes that reach the server late (offline) should be stamped again by the backend so they land
// after everyone's lastSync. Limits (healed by the weekly full read): a record deleted for good without a bin entry
// while another device was closed stays on that device until then; so does a write stamped by a clock more than SKEW
// behind, or missed by a reader whose own clock stays more than SKEW ahead.
//
// Backend, injected:
// listen(scope, coll, { since, epoch, field }, onSnap, onError) -> unsubscribe
//   since: null = the whole collection. onSnap({ changes: [{ type: 'added'|'modified'|'removed', id, doc, pending? }],
//   fromCache, hasPendingWrites, full?, docs?, epoch? }); full: docs is the whole collection, confirmed by the server.
// fetchOne(scope, coll, id) -> doc | null (throws when it can't tell, e.g. offline)
//
// Stamps (updatedAt, deletedAt) are numbers (ms) or ISO strings; timeOf reads either. Options for apps adopting the
// engine from whole-collection listeners: unstamped: 'full' reads in full while any record held here has no
// updatedAt (until a backfill stamps them all; a delta read would never see such a record change), and expire
// ({ field, after }) drops a soft-deleted record from this device once that field is older than after (the time
// after which the app removes it for good, which no delta listener hears).
//
// Server stamps (stampMode: 'server', 0.3.0): each write also carries serverField (default serverAt), set by the
// server (Firestore serverTimestamp()), and the delta read is serverAt > the newest server stamp this device has had
// confirmed (meta.anchor): no SKEW and no local clock, so a write that reached the server late (offline for days) or
// a reader whose clock is off still meets. A stamp not yet resolved (this device's write not on the server: null, or
// an estimate) and a cached snapshot never move the anchor. A held document without a server stamp (written before
// adoption, or by an older app version) makes every open a full read until a backfill stamps it. updatedAt stays as
// it was (conflict checks and tombstones still use it). The weekly full read stays (deletes without a tombstone).
//
// Extra tombstone feeds (feeds: { [coll]: kinds }): like the bin, for records that left a query without being
// deleted (locked, moved, access removed), which a delta listener never hears of. leaveEntry builds the entry an app
// writes there; its deletedAt is max(at, the record's updatedAt + 1), in the type of at (a number, or an ISO string).
//
// Unsent saves (0.4.0): unsent(id) says a held record still has saves this device has not sent (queue.unsent). Such a
// record that leaves the query (locked, moved, deleted elsewhere), or whose bin or feed entry arrives (0.4.1), stays
// on this device and onLeave(id, doc) reports it, so the app can tell the user and the save meets the server's answer
// (a conflict, kept for the user) instead of the record vanishing with the change in it.
//
// Deferred tombstones (0.6.3): such a kept record's tombstone is remembered (meta.later) and applied once its saves are
// done (settle), so a delete heard while a save was held still removes the record when the answer leaves it deleted
// (or leaves this device's copy at or below the deleted version). tomb(id) is the highest tombstone known here for a
// record (deleted, or deferred), so a record created again can be stamped above it (copies at or below it are hidden).

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Stamp} Stamp
 * @typedef {import('./types.js').CollMeta} CollMeta
 * @typedef {import('./types.js').Change} Change
 * @typedef {import('./types.js').Snapshot} Snapshot
 * @typedef {import('./types.js').SnapMeta} SnapMeta
 * @typedef {import('./types.js').Tomb} Tomb
 * @typedef {import('./types.js').Listen} Listen
 * @typedef {import('./types.js').FetchOne} FetchOne
 * @typedef {import('./types.js').EngineStore} EngineStore
 * @typedef {import('./types.js').ExpireRule} ExpireRule
 */

export const SKEW = 10 * 60e3;          // clocks may be this far behind
export const FULL_EVERY = 7 * 864e5;     // a full read at least weekly
export const GONE_KEEP = 8 * 864e5;      // deleted ids remembered (longer than the weekly full read)
export const REPLAN_EVERY = 3600e3;     // a page left open checks hourly whether its full read is due

/** @template T @param {T} v @returns {T} */
const copy = v => JSON.parse(JSON.stringify(v));
/** @param {any} a @param {any} b */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// a stamp as ms: a number, or an ISO string (0: none or unreadable)
/** @param {any} v @returns {number} */
export const timeOf = v => typeof v === 'string' ? Date.parse(v) || 0 : Number(v) || 0;
/** @param {any} d */
const stamp = d => timeOf(d && d.updatedAt);

// ---- pure helpers (test/sync.test.mjs) ----

// What to read now: the whole collection (first time, a week since the last full read, a clock gone back), or only
// what changed since the last confirmed sync. newest: the highest updatedAt in the stored copy (0: none): anything
// written after it is read too, so the time read from is anchored to the writers' stamps, not only to this clock.
/**
 * @param {CollMeta | null | undefined} meta
 * @param {number} now
 * @param {number} [newest]
 * @returns {{ full: boolean, since: number | null }}
 */
export function plan(meta, now, newest = 0) {
  const m = /** @type {{ fullAt: number, syncAt: number, anchor: number }} */ (meta || {});
  const full = !(m.fullAt > 0) || !(m.syncAt > 0) || now - m.fullAt > FULL_EVERY || m.fullAt > now + SKEW;
  return { full, since: full ? null : Math.min(Math.min(m.syncAt, now) - SKEW, newest > 0 ? newest : Infinity) };
}

// The same with server stamps: from the newest confirmed server stamp (meta.anchor), with no SKEW (the server's clock
// stamped every document); a full read first, weekly, with no anchor yet, or when this clock went back.
/**
 * @param {CollMeta | null | undefined} meta
 * @param {number} now
 * @returns {{ full: boolean, since: number | null }}
 */
export function planServer(meta, now) {
  const m = /** @type {{ fullAt: number, syncAt: number, anchor: number }} */ (meta || {});
  const full = !(m.fullAt > 0) || !(m.anchor > 0) || now - m.fullAt > FULL_EVERY || m.fullAt > now + SKEW;
  return { full, since: full ? null : m.anchor - 1 };
}

// the newest resolved server stamp in a confirmed snapshot's documents (skipping this device's pending writes)
/** @param {Iterable<any>} docs @param {Set<string>} pending @param {string} field */
const newestServer = (docs, pending, field) => { let n = 0; for (const d of docs) if (d && !pending.has(d.id)) n = Math.max(n, timeOf(d[field])); return n; };

// A record that left a query without being deleted (locked, moved): the entry an app writes to an extra tombstone
// feed, so devices holding that version (or older) drop it at their next open. A newer version shows again.
/**
 * @param {string} kind
 * @param {Doc} record
 * @param {Stamp} [at]
 * @returns {{ id: string, kind: string, data: { id: string, updatedAt: Stamp | undefined }, deletedAt: Stamp }}
 */
export const leaveEntry = (kind, record, at = Date.now()) => {
  const t = Math.max(timeOf(at), timeOf(record.updatedAt) + 1);
  return { id: kind + ':' + record.id, kind, data: { id: String(record.id), updatedAt: record.updatedAt }, deletedAt: typeof at === 'string' ? new Date(t).toISOString() : t };
};

// Apply a snapshot's changes to docs (a Map, changed in place). A copy older than a known deletion is stale and
// skipped. A removal goes at once when the deletion is known or sure(id) says the server confirmed it; otherwise it
// is returned in verify (e.g. this device's refused write leaving the query), to be checked with one read.
/**
 * @param {Map<string, Doc>} docs
 * @param {Change[] | null | undefined} changes
 * @param {Record<string, number>} [gone]
 * @param {(id: string) => boolean} [sure]
 * @returns {{ put: Doc[], del: string[], verify: string[] }}
 */
export function applyChanges(docs, changes, gone = {}, sure = () => false) {
  const put = [], del = [], verify = [];
  for (const c of changes || []) {
    if (c.type === 'removed') {
      if (!docs.has(c.id)) continue;
      if (gone[c.id] != null || sure(c.id)) { docs.delete(c.id); del.push(c.id); } else verify.push(c.id);
      continue;
    }
    if (!c.doc || (gone[c.id] != null && stamp(c.doc) <= gone[c.id])) continue;
    if (docs.has(c.id) && same(docs.get(c.id), c.doc)) continue;
    docs.set(c.id, c.doc); put.push(c.doc);
  }
  return { put, del, verify };
}

// Replace docs with the server's whole list; returns what changed (so only that is written to the device).
/**
 * @param {Map<string, Doc>} docs
 * @param {Doc[]} list
 * @returns {{ put: Doc[], del: string[] }}
 */
export function replaceAll(docs, list) {
  const next = new Map(list.map(d => [d.id, d]));
  const put = list.filter(d => !docs.has(d.id) || !same(docs.get(d.id), d));
  const del = [...docs.keys()].filter(id => !next.has(id));
  docs.clear(); for (const [id, d] of next) docs.set(id, d);
  return { put, del };
}

// Tombstones [{ id, deletedAt }]: remove each record unless it changed after that time; remember the ids. (From the
// bin, the time is the binned version's updatedAt: binTombs.)
/**
 * @param {Map<string, Doc>} docs
 * @param {Record<string, number>} gone
 * @param {Tomb[] | null | undefined} tombs
 * @returns {string[]} the ids removed
 */
export function applyTombs(docs, gone, tombs) {
  const del = [];
  for (const t of tombs || []) {
    const at = timeOf(t.deletedAt);
    if (!t.id || !at) continue;
    gone[t.id] = Math.max(gone[t.id] || 0, at);
    if (docs.has(t.id) && stamp(docs.get(t.id)) <= at) { docs.delete(t.id); del.push(t.id); }
  }
  return del;
}

// records deleted on this device -> tombstones: each at the deleted version's stamp; one not held here keeps its
// tombstone (1.3.11), at (now) only for one with neither
/** @param {Map<string, Doc>} docs @param {any[]} ids @param {number} at @param {Record<string, number>} [gone] @returns {Tomb[]} */
export const dropTombs = (docs, ids, at, gone = {}) => ids.map(id => ({ id: String(id), deletedAt: stamp(docs.get(String(id))) || gone[String(id)] || at }));

// tombstones [{ id, deletedAt }] kept back (the record has saves not sent) -> later, { id: ms }, the highest per id
/**
 * @param {Record<string, number> | null | undefined} later
 * @param {Tomb[] | null | undefined} tombs
 * @returns {Record<string, number>}
 */
export function deferTombs(later, tombs) {
  const out = { ...(later || {}) };
  for (const t of tombs || []) { const at = timeOf(t && t.deletedAt); if (t && t.id && at) out[t.id] = Math.max(out[t.id] || 0, at); }
  return out;
}

// deferred tombstones (meta.later) of records not held any more (holding(id) false; ids: only those) applied to docs as
// any tombstone: removed unless changed after it, and remembered in gone. -> { meta, del } (null: nothing to do)
/**
 * @param {Map<string, Doc>} docs
 * @param {CollMeta} meta
 * @param {string[] | null} ids
 * @param {(id: string) => boolean} holding
 * @returns {{ meta: CollMeta, del: string[] } | null}
 */
export function settleTombs(docs, meta, ids, holding) {
  const later = meta.later || {}, due = Object.keys(later).filter(id => (!ids || ids.includes(id)) && !holding(id));
  if (!due.length) return null;
  const gone = { ...(meta.gone || {}) }, rest = { ...later };
  const del = applyTombs(docs, gone, due.map(id => ({ id, deletedAt: later[id] })));
  for (const id of due) delete rest[id];
  return { meta: { ...meta, gone, later: rest }, del };
}

/** @param {Record<string, number> | null | undefined} gone @param {number} now @returns {Record<string, number>} */
export const pruneGone = (gone, now) => Object.fromEntries(Object.entries(gone || {}).filter(([, t]) => t > now - GONE_KEEP));

// recycle bin entries { kind, data, deletedAt } -> tombstones per collection, kinds mapping an entry's kind to its
// collection ({ item: 'items' } -> { items: [{ id, deletedAt }] }). The time is the binned
// version's updatedAt, even when a fast clock stamped it after deletedAt (a copy of that version must still go): a copy
// changed since then survives, so a bin entry whose delete was refused (the record changed elsewhere) removes nothing.
// Older entries without one use deletedAt.
/**
 * @param {any[] | null | undefined} entries
 * @param {Record<string, string>} [kinds]
 * @returns {Record<string, Tomb[]>}
 */
export function binTombs(entries, kinds = {}) {
  /** @type {Record<string, Tomb[]>} */
  const out = {};
  for (const e of entries || []) {
    const coll = e && Object.hasOwn(kinds, e.kind) ? kinds[e.kind] : null, id = e && e.data && e.data.id;
    if (!coll || !id) continue;
    const at = timeOf(e.deletedAt), version = timeOf(e.data.updatedAt);
    (out[coll] ||= []).push({ id: String(id), deletedAt: version > 0 ? version : at });
  }
  return out;
}

// Soft-deleted records whose field (e.g. removedAt) is older than rule.after: removed from docs and remembered in
// gone at their stamp (so a copy restored later, stamped after it, shows again). rule null: none. -> ids removed
/**
 * @param {Map<string, Doc>} docs
 * @param {Record<string, number>} gone
 * @param {ExpireRule | undefined} rule
 * @param {number} now
 * @returns {string[]}
 */
export function expireDocs(docs, gone, rule, now) {
  if (!rule || !rule.field || !(rule.after > 0)) return [];
  const del = [];
  for (const [id, d] of docs) {
    const at = timeOf(d && d[rule.field]);
    if (at > 0 && at < now - rule.after) { docs.delete(id); del.push(id); gone[id] = Math.max(gone[id] || 0, stamp(d) || at); }
  }
  return del;
}

// Stamp ids again one small write at a time (a batch fails whole when one of them was deleted since); a failed one
// is skipped. write(id) -> Promise. Resolves to the ids stamped.
/**
 * @param {string[]} ids
 * @param {(id: string) => Promise<any>} write
 * @param {number} [size]
 * @returns {Promise<string[]>}
 */
export async function eachSettled(ids, write, size = 20) {
  /** @type {string[]} */
  const done = [];
  for (let i = 0; i < ids.length; i += size) {
    const part = ids.slice(i, i + size);
    const r = await Promise.allSettled(part.map(id => write(id)));
    r.forEach((x, j) => { if (x.status === 'fulfilled') done.push(part[j]); });
  }
  return done;
}

// ---- one collection ----

// subscribe(cb) -> unsubscribe; cb(list, { fromCache, hasPendingWrites }) with the whole merged list (a copy each time).
/**
 * @typedef {object} CollectionSyncOptions
 * @property {string} scope
 * @property {string} coll
 * @property {EngineStore} store
 * @property {Listen} listen
 * @property {FetchOne | null} [fetchOne]
 * @property {() => number} [now]
 * @property {(e: any) => void} [onError]
 * @property {'skip' | 'full'} [unstamped]
 * @property {ExpireRule} [expire]
 * @property {'client' | 'server'} [stampMode]
 * @property {string} [serverField]
 * @property {(id: string) => boolean} [unsent]
 * @property {(id: string, doc: Doc) => void} [onLeave]
 */
/** @param {CollectionSyncOptions} options */
export function createCollectionSync({ scope, coll, store, listen, fetchOne = null, now = Date.now, onError = () => {}, unstamped = 'skip', expire = null, stampMode = 'client', serverField = 'serverAt', unsent = () => false, onLeave = () => {} }) {
  const server = stampMode === 'server';
  // a held record with saves not sent yet (can't tell: kept, the safe side)
  /** @param {string} id */
  const holding = id => { try { return docs.has(id) && !!unsent(id); } catch { return docs.has(id); } };
  /** @param {string} id */
  const left = id => { try { onLeave(id, copy(/** @type {Doc} */ (docs.get(id)))); } catch (e) { console.warn('onLeave', e); } };
  /** @type {Set<(list: Doc[], meta: SnapMeta) => void>} */
  const subs = new Set();
  const local = new Set();   // local: ids last seen with this device's write pending
  /** @type {Map<string, Doc>} */
  let docs = new Map();
  /** @type {CollMeta} */
  let meta = {};
  /** @type {SnapMeta | null} */
  let flags = null;
  /** @type {(() => void) | null} */
  let unlisten = null, refused = false;   // refused: the server said permission-denied; the next replan listens again
  /** @type {Promise<any>} */
  let chain = Promise.resolve();
  /** @type {{ full: boolean, since: number | null } | null} */
  let planned = null;
  let stopped = false, runs = 0;
  // A write that fails (storage full) leaves the device's copy short of what meta claims: until a later write puts the
  // whole list back (replace), nothing else is written, and the next start reads everything (fullAt 0).
  let dirty = false;
  /** @param {{ put?: Doc[], del?: string[], meta?: CollMeta, replace?: boolean }} op */
  const persist = op => (chain = chain.then(async () => {
    const heal = dirty;
    await store.write(coll, heal ? { replace: true, put: [...docs.values()], meta } : op);
    if (heal) dirty = false;
  }).catch(e => { dirty = true; meta = { ...meta, fullAt: 0 }; console.warn('Local store not saved', e); }));
  /** @param {(list: Doc[], meta: SnapMeta) => void} cb @param {string} [text] the list as JSON, if already made */
  const send = (cb, text) => { if (flags && subs.has(cb)) cb(text === undefined ? copy([...docs.values()]) : JSON.parse(text), { ...flags }); };
  // (1.3.12) the list stringified once for all subscribers, each still gets its own copy (docs change only after an
  // await, never while emit runs: every change below waits for ready or a read first)
  const emit = () => { if (!flags || !subs.size) return; const text = JSON.stringify([...docs.values()]); for (const cb of subs) send(cb, text); };

  const ready = (async () => {
    const got = await store.load(coll);
    if (stopped) return;
    docs = new Map(got.docs.map(d => [d.id, d]));
    meta = got.meta || {};
    const swept = expireDocs(docs, meta.gone ||= {}, expire, now());
    if (swept.length) persist({ del: swept, meta });
    // a list confirmed before shows at once; a device that never synced waits for the listener (as Firestore did)
    if (meta.syncAt) { flags = { fromCache: true, hasPendingWrites: false }; emit(); }
    // tombstones deferred on an earlier page whose record's saves are done since
    const settled = settleTombs(docs, meta, null, holding);
    if (settled) { meta = settled.meta; persist({ del: settled.del, meta }); if (settled.del.length && flags) emit(); }
    start();
  })().catch(onError);

  const newestHeld = () => { let n = 0; for (const d of docs.values()) n = Math.max(n, stamp(d)); return n; };
  const anyUnstamped = () => { for (const d of docs.values()) if (!stamp(d)) return true; return false; };
  const anyUnresolved = () => { for (const d of docs.values()) if (!(timeOf(d && d[serverField]) > 0)) return true; return false; };
  const planNow = () => {
    if (server) { const p = planServer(meta, now()); return !p.full && anyUnresolved() ? { full: true, since: null } : p; }
    const p = plan(meta, now(), newestHeld()); return !p.full && unstamped === 'full' && anyUnstamped() ? { full: true, since: null } : p;
  };
  // (re)start the listener from meta; an older listener's late snapshots are ignored
  function start() {
    const run = ++runs;
    if (unlisten) { unlisten(); unlisten = null; }
    const p = planNow();
    planned = p;
    refused = false;
    unlisten = listen(scope, coll, { since: p.since, epoch: meta.epoch, ...(server ? { field: serverField } : {}) }, s => { if (run === runs) onSnap(s); }, e => { if (run === runs && e && e.code === 'permission-denied') refused = true; onError(e); });
    if (stopped) unlisten();
  }

  /** @param {Snapshot} s */
  function onSnap(s) {
    if (stopped) return;
    const t = now();
    let changed = false;
    // server stamps: the anchor moves only on what the server confirmed, never on this device's pending writes
    const pending = new Set((s.changes || []).filter(c => c.pending).map(c => c.id));
    if (s.full) {
      // (1.3.13) a copy at or before a known deletion stays out (the bin's tombstone can land before this first full
      // read), as on the delta path; a newer copy held here stays
      const gone = meta.gone || {}, stale = (/** @type {Doc} */ d) => gone[d.id] != null && stamp(d) <= gone[d.id];
      const list = /** @type {Doc[]} */ ((s.docs || []).map(d => stale(d) ? docs.get(d.id) : d).filter(d => d && !stale(d)));
      const there = new Set(list.map(d => d.id));
      const kept = [...docs.keys()].filter(id => !there.has(id) && holding(id));
      const r = replaceAll(docs, [...list, .../** @type {Doc[]} */ (kept.map(id => docs.get(id)))]);
      for (const id of kept) left(id);
      meta = { ...meta, syncAt: t, fullAt: t, gone: pruneGone(meta.gone, t), ...(meta.later ? { later: pruneGone(meta.later, t) } : {}), ...(s.epoch !== undefined ? { epoch: s.epoch } : {}),
        ...(server ? { anchor: newestServer(s.docs || [], pending, serverField) } : {}) };
      const swept = expireDocs(docs, /** @type {Record<string, number>} */ (meta.gone), expire, t);
      if (swept.length) r.put = r.put.filter(d => !swept.includes(d.id)), r.del.push(...swept);
      changed = !!(r.put.length || r.del.length);
      persist({ ...r, meta });
    } else {
      const unsure = new Set();
      /** @type {string[]} */
      const kept = [];
      const changes = (s.changes || []).filter(c => c.type !== 'removed' || !holding(c.id) || (kept.push(c.id), false));
      for (const c of changes) {
        if (c.type === 'removed') { if (s.fromCache || local.has(c.id)) unsure.add(c.id); local.delete(c.id); }
        else if (c.pending) local.add(c.id); else local.delete(c.id);
      }
      const r = applyChanges(docs, changes, meta.gone || {}, id => !unsure.has(id));
      for (const id of kept) left(id);
      const swept = expireDocs(docs, meta.gone ||= {}, expire, t);
      if (swept.length) r.put = r.put.filter(d => !swept.includes(d.id)), r.del.push(...swept);
      changed = !!(r.put.length || r.del.length);
      if (!s.fromCache) meta = { ...meta, syncAt: t };
      if (server && !s.fromCache) {
        const n = newestServer((s.changes || []).filter(c => c.type !== 'removed').map(c => c.doc), pending, serverField);
        if (n > (Number(meta.anchor) || 0)) meta = { ...meta, anchor: n };
      }
      if (changed || !s.fromCache) persist({ put: r.put, del: r.del, meta });
      for (const id of r.verify) verify(id);
    }
    const f = { fromCache: !!s.fromCache, hasPendingWrites: !!s.hasPendingWrites };
    if (changed || !flags || f.fromCache !== flags.fromCache || f.hasPendingWrites !== flags.hasPendingWrites) { flags = f; emit(); }
  }

  // a record left the query without a known deletion: one read says whether it still exists
  /** @param {string} id */
  async function verify(id) {
    /** @type {Doc | null | undefined} */
    let doc;
    const before = docs.get(id);
    try { doc = fetchOne ? await fetchOne(scope, coll, id) : undefined; } catch { doc = undefined; }
    if (stopped || docs.get(id) !== before) return;   // a snapshot changed this record while the read was out: it is newer
    const gone = meta.gone || {};
    if (!(doc && !(gone[id] != null && stamp(doc) <= gone[id])) && holding(id)) { left(id); return; }
    if (doc && !(gone[id] != null && stamp(doc) <= gone[id])) {
      if (same(docs.get(id), doc)) return;
      docs.set(id, doc); persist({ put: [doc], meta });
    } else {
      // couldn't tell (offline): most likely deleted elsewhere; the next start reads everything to be sure
      if (doc === undefined) meta = { ...meta, fullAt: 0 };
      docs.delete(id); persist({ del: [id], meta });
    }
    emit();
  }

  return {
    /** @param {(list: Doc[], meta: SnapMeta) => void} cb @returns {() => boolean} */
    subscribe(cb) { subs.add(cb); if (flags) queueMicrotask(() => send(cb)); return () => subs.delete(cb); },
    get size() { return subs.size; },
    ready,
    // a page left open for days: once a full read is due, listen again from scratch (the whole collection), which
    // also stops the open delta query's result set growing for good. -> true when it restarted
    replan() { if (stopped || !planned) return false; if (!refused && (planned.full || !planNow().full)) return false; start(); return true; },
    // deleted here (for good, or into the bin): gone at once, and copies of that version (or older) arriving later are
    // ignored; the tombstone is the deleted version's stamp (not this clock), so a restore stamped after it shows
    /** @param {string[]} ids @param {number} [at] */
    async drop(ids, at = now()) {
      await ready;
      const del = applyTombs(docs, meta.gone ||= {}, dropTombs(docs, ids, at, meta.gone));
      await persist({ del, meta });
      if (del.length) emit();
    },
    // (1.3.9) the server's answer to this device's save, into the list and the device copy before the save counts as
    // done (the listener may not hear it before the page goes offline and reloads). Never over a newer copy held or a
    // tombstone at or after it; a server stamp not resolved yet is left out (the listener brings the stored one)
    /** @param {Doc} doc */
    async land(doc) {
      await ready;
      if (stopped || !doc || doc.id == null) return;
      const id = String(doc.id), held = docs.get(id), gone = meta.gone || {};
      if (doc._deleted) return this.drop([id]);
      const d = /** @type {Doc & Record<string, any>} */ ({ ...doc, id });
      if (server && !(timeOf(d[serverField]) > 0)) delete d[serverField];
      if ((gone[id] != null && stamp(d) <= gone[id]) || (held && stamp(held) > stamp(d)) || (held && same(held, d))) return;
      docs.set(id, d);
      await persist({ put: [d], meta });
      emit();
    },
    // tombstones from the bin or a feed; a record with saves not sent yet stays and is reported, as when it leaves
    // the query (its tombstone is not remembered, so the save's answer shows)
    /** @param {Tomb[] | null | undefined} list */
    async tombs(list) {
      await ready;
      const kept = (list || []).filter(t => t && t.id && holding(t.id) && stamp(docs.get(t.id)) <= timeOf(t.deletedAt));
      const del = applyTombs(docs, meta.gone ||= {}, (list || []).filter(t => !kept.includes(t)));
      if (kept.length) meta = { ...meta, later: deferTombs(meta.later, kept) };
      for (const t of kept) left(t.id);
      await persist({ del, meta });
      if (del.length) emit();
    },
    // deferred tombstones of records whose saves are done now (ids: only those; default all) -> ids removed
    /** @param {string[] | null} [ids] @returns {Promise<string[]>} */
    async settle(ids = null) {
      await ready;
      if (stopped) return [];
      const r = settleTombs(docs, meta, ids, holding);
      if (!r) return [];
      meta = r.meta;
      await persist({ del: r.del, meta });
      if (r.del.length) emit();
      return r.del;
    },
    // the highest tombstone known here for id (ms; 0: none)
    /** @param {string} id */
    tomb: id => Math.max(Number((meta.gone || {})[id]) || 0, Number((meta.later || {})[id]) || 0),
    waiting: () => Object.keys(meta.later || {}),
    // the device's store was deleted under this engine (another tab signed out or switched account) and opened
    // again empty: write the whole list back, and read everything at the next start, since the list may be partial
    wiped() {
      if (stopped) return chain;
      meta = { ...meta, fullAt: 0 };
      return persist({ replace: true, put: [...docs.values()], meta });
    },
    stop() { stopped = true; subs.clear(); if (unlisten) unlisten(); return chain; },
    flush: () => chain,
  };
}

// ---- the recycle bin as a feed of tombstones ----
// Listens to bin entries changed since the last sync (deletedAt) and hands them on; keeps only its meta record.
/**
 * @typedef {object} TombFeedOptions
 * @property {string} scope
 * @property {EngineStore} store
 * @property {Listen} listen
 * @property {(byColl: Record<string, Tomb[]>) => Promise<void>} apply
 * @property {Record<string, string>} [kinds]
 * @property {string} [coll]
 * @property {() => number} [now]
 * @property {(e: any) => void} [onError]
 * @property {'client' | 'server'} [stampMode]
 * @property {string} [serverField]
 */
/** @param {TombFeedOptions} options */
export function createTombFeed({ scope, store, listen, apply, kinds = {}, coll = 'bin', now = Date.now, onError = () => {}, stampMode = 'client', serverField = 'serverAt' }) {
  const server = stampMode === 'server';
  const planNow = () => server ? planServer(meta, now()) : plan(meta, now(), Number(meta.newest) || 0);
  /** @type {CollMeta} */
  let meta = {};
  /** @type {(() => void) | null} */
  let unlisten = null, refused = false;
  /** @type {Promise<any>} */
  let chain = Promise.resolve();
  /** @type {{ full: boolean, since: number | null } | null} */
  let planned = null;
  let stopped = false, runs = 0;
  const ready = (async () => {
    meta = (await store.load(coll)).meta || {};
    if (stopped) return;
    start();
  })().catch(onError);
  // (re)start the listener from meta; an older listener's late snapshots are ignored (run)
  function start() {
    const run = ++runs;
    if (unlisten) { unlisten(); unlisten = null; }
    // anchored to the newest deletedAt seen, as collections are to their newest stamp: a reader whose clock ran
    // ahead at its last sync still hears entries others stamped since
    const p = planNow();
    planned = p;
    refused = false;
    unlisten = listen(scope, coll, { since: p.since, epoch: meta.epoch, field: server ? serverField : 'deletedAt' }, s => {
      if (stopped || run !== runs) return;
      const entries = s.full ? s.docs || [] : (s.changes || []).filter(c => c.type !== 'removed').map(c => c.doc);
      const t = now();
      const confirmed = !s.fromCache || s.full;
      const newest = entries.reduce((n, e) => Math.max(n, timeOf(e && e.deletedAt)), 0);
      const anchor = server ? newestServer(entries, new Set((s.changes || []).filter(c => c.pending).map(c => c.id)), serverField) : 0;
      chain = chain.then(async () => {
        if (entries.length) await apply(binTombs(entries, kinds));
        if (stopped || !confirmed) return;
        meta = { ...meta, syncAt: t, ...(s.full ? { fullAt: t } : {}), ...(s.epoch !== undefined ? { epoch: s.epoch } : {}),
          ...(newest > (Number(meta.newest) || 0) && newest <= t + SKEW ? { newest } : {}),
          ...(server && (s.full || anchor > (Number(meta.anchor) || 0)) ? { anchor } : {}) };
        await store.write(coll, { meta });
      }).catch(e => console.warn('Tombstone feed sync failed', e));
    }, e => { if (run === runs && e && e.code === 'permission-denied') refused = true; onError(e); });
    if (stopped) unlisten();
  }
  return {
    ready,
    // a page left open: read the whole bin again once a full read is due
    replan() { if (stopped || !planned) return false; if (!refused && (planned.full || !planNow().full)) return false; start(); return true; },
    // its store was deleted and opened again: tombstones may have been missed, so read the whole bin next time
    wiped() { if (stopped) return chain; meta = { ...meta, fullAt: 0 }; return (chain = chain.then(() => store.write(coll, { meta })).catch(e => console.warn('Tombstone feed sync failed', e))); },
    stop() { stopped = true; if (unlisten) unlisten(); return chain; },
    flush: () => chain,
  };
}

// ---- all collections of the signed-in account(s) ----
// One engine per account and collection, shared by every caller (two callers never cost two listeners); the bin
// feed runs while any of them does. An engine nobody watches stops after a short grace, so a caller that stops and
// starts again (the app re-runs its start when the demo changes in another tab) keeps the same listener.
// bin: the tombstone collection's name (null: no bin feed); binKinds: an entry's kind -> its collection. feeds:
// { [coll]: kinds }, more tombstone feeds of the same shape (records that left a query; list them in the stores'
// metaOnly); feedsIn(scope): the scopes the bin and feeds are listened in (default: all). unstamped ('skip' | 'full'),
// expire ({ [coll]: { field, after } }) and stampMode ('client' | 'server', with serverField; the bin and feeds too):
// see the top of this file.
export const GRACE = 1500;
// (1.3.9) landSaved(hub, scope, coll, doc) -> Promise: the server's answer to a save into that collection's running
// engine (its list and the device copy); a collection no page watches gets it at its next listen. Internal (core.js),
// not a method of the hub, which is public.
/** @type {WeakMap<object, (scope: string, coll: string, doc: Doc) => Promise<void>>} */
const landers = new WeakMap();
/** @param {object} hub @param {string} scope @param {string} coll @param {Doc} doc @returns {Promise<void>} */
export function landSaved(hub, scope, coll, doc) { const fn = landers.get(hub); return fn ? fn(scope, coll, doc) : Promise.resolve(); }

/**
 * @typedef {object} SyncHubOptions
 * @property {(scope: string) => Promise<import('./types.js').Store>} openStore
 * @property {Listen} listen
 * @property {FetchOne | null} [fetchOne]
 * @property {() => number} [now]
 * @property {(e: any) => void} [onError]
 * @property {number} [grace]
 * @property {string | null} [bin]
 * @property {Record<string, string>} [binKinds]
 * @property {Record<string, Record<string, string>>} [feeds]
 * @property {(scope: string) => boolean} [feedsIn]
 * @property {'skip' | 'full'} [unstamped]
 * @property {Record<string, { field: string, after: number }>} [expire]
 * @property {'client' | 'server'} [stampMode]
 * @property {string} [serverField]
 * @property {(scope: string, coll: string, id: string) => boolean} [unsent]
 * @property {(scope: string, coll: string, id: string, doc: Doc) => void} [onLeave]
 */
/** @param {SyncHubOptions} options */
export function createSyncHub({ openStore, listen, fetchOne = null, now = Date.now, onError = () => {}, grace = GRACE, bin = 'bin', binKinds = {}, feeds: extraFeeds = {}, feedsIn = () => true, unstamped = 'skip', expire = {}, stampMode = 'client', serverField = 'serverAt', unsent = () => false, onLeave = () => {} }) {
  /** @type {WeakMap<object, Listen>} the app's own listener of an engine (watch's own) */
  const ownListen = new WeakMap();
  const feedKinds = [...(bin ? /** @type {[string, Record<string, string>][]} */ ([[bin, binKinds]]) : []), ...Object.entries(extraFeeds || {}).filter(([c]) => c && c !== bin)];
  const engines = new Map(), feeds = new Map(), stores = new Map(), timers = new Map(), stopping = new Map(), tombing = new Map();
  const waiting = new Set();   // scope\ncoll\nid with a deferred tombstone in a collection's stored copy (not running)
  /** @param {string} scope @param {string} coll */
  const key = (scope, coll) => scope + '\n' + coll;
  /** @param {string} scope @returns {Promise<import('./types.js').Store>} */
  async function storeFor(scope) {
    let s = stores.get(scope);
    if (s) { const got = await s; if (!got.closed) return got; }
    const p = stores.get(scope);
    if (p && p !== s) return storeFor(scope);   // another caller is opening it again already
    s = openStore(scope);
    stores.set(scope, s);
    // deleted under running engines (another tab): they write their whole lists back and read in full next time
    if (p) s.then(() => {
      if (stores.get(scope) !== s) return;
      for (const [k, e] of engines) if (k.startsWith(scope + '\n')) e.wiped();
      for (const [k, f] of feeds) if (k.startsWith(scope + '\n')) f.wiped();
    });
    return s;
  }
  // a store opened lazily behind the same interface, so callers needn't wait for it; a load waits for the local writes
  // of an engine just stopped on the same collection
  // (and for tombstones being written straight into it, so an engine starting meanwhile reads them and its meta
  // writes keep them)
  /** @param {string} scope @returns {EngineStore} */
  const lazyStore = scope => ({
    load: async coll => {
      const k = key(scope, coll);
      await stopping.get(k);
      await (tombing.get(k) || Promise.resolve()).catch(() => {});
      return (await storeFor(scope)).load(coll);
    },
    write: async (/** @type {string} */ coll, /** @type {any} */ op) => (await storeFor(scope)).write(coll, op),
  });
  // tombstones for a collection that isn't running: straight into its stored copy, one after another per collection
  /** @param {string} scope @param {string} coll @param {any[]} list @param {boolean} [drop] @returns {Promise<void>} */
  function storeTombs(scope, coll, list, drop = false) {
    const k = key(scope, coll);
    const run = (tombing.get(k) || Promise.resolve()).catch(() => {}).then(async () => {
      await stopping.get(k);
      const st = await storeFor(scope), got = await st.load(coll);
      const docs = new Map(got.docs.map(d => [d.id, d])), meta = got.meta || {};
      // (as a running engine: a record with saves not sent yet stays, reported)
      /** @param {Tomb} t */
      const held = t => { if (!docs.has(t.id) || stamp(docs.get(t.id)) > timeOf(t.deletedAt)) return false; try { return !!unsent(scope, coll, t.id); } catch { return true; } };
      const kept = drop ? [] : (list || []).filter(t => t && t.id && held(t));
      const del = applyTombs(docs, meta.gone ||= {}, drop ? dropTombs(docs, list, now(), meta.gone) : list.filter(t => !kept.includes(t)));
      let m = kept.length ? { ...meta, later: deferTombs(meta.later, kept) } : meta;
      for (const t of kept) { try { onLeave(scope, coll, t.id, copy(/** @type {Doc} */ (docs.get(t.id)))); } catch (e) { console.warn('onLeave', e); } }
      // (and deferred ones whose saves are done: a settle, here while the collection isn't running)
      const settled = settleTombs(docs, m, null, id => { try { return docs.has(id) && !!unsent(scope, coll, id); } catch { return docs.has(id); } });
      if (settled) { m = settled.meta; del.push(...settled.del); }
      for (const id of Object.keys(m.later || {})) waiting.add(key(scope, coll) + '\n' + id);
      await st.write(coll, { del, meta: m });
    });
    const tracked = run.finally(() => { if (tombing.get(k) === tracked) tombing.delete(k); });
    tracked.catch(() => {});
    tombing.set(k, tracked);
    return run;
  }
  /** @param {string} scope */
  function tombsFor(scope) {
    return async (/** @type {Record<string, Tomb[]>} */ byColl) => {
      for (const [coll, list] of Object.entries(byColl)) {
        const e = engines.get(key(scope, coll));
        await (e ? e.tombs(list) : storeTombs(scope, coll, list));
      }
    };
  }
  // an engine stopped and forgotten; a watch of its collection waits for that before it opens the store again
  /** @param {string} k @param {ReturnType<typeof createCollectionSync>} e */
  function end(k, e) {
    engines.delete(k);
    const done = e.stop().finally(() => { if (stopping.get(k) === done) stopping.delete(k); });
    stopping.set(k, done);
    return done;
  }
  /** @param {string} scope */
  function idle(scope) {
    if ([...engines.keys()].some(k => k.startsWith(scope + '\n'))) return;
    for (const [k, f] of feeds) if (k.startsWith(scope + '\n')) { f.stop(); feeds.delete(k); }
  }
  const hub = {
    // own (1.2.0): the app's listener for this collection instead of listen; one way at a time per collection
    /** @param {string} scope @param {string} coll @param {(list: Doc[], meta: SnapMeta) => void} cb @param {Listen | null} [own] @returns {() => void} */
    watch(scope, coll, cb, own = null) {
      const k = key(scope, coll);
      let e = engines.get(k);
      if (e && own && ownListen.get(e) !== own) throw new Error('watch: ' + coll + ' is already listened to another way');
      if (!e) { e = createCollectionSync({ scope, coll, store: lazyStore(scope), listen: own || listen, fetchOne, now, onError, unstamped, expire: (expire && Object.hasOwn(expire, coll) && expire[coll]) || null, stampMode, serverField,
        unsent: id => unsent(scope, coll, id), onLeave: (id, doc) => onLeave(scope, coll, id, doc) }); engines.set(k, e); if (own) ownListen.set(e, own); }
      for (const [fc, kinds] of feedsIn(scope) ? feedKinds : []) {
        const fk = key(scope, fc);
        if (!feeds.has(fk)) feeds.set(fk, createTombFeed({ scope, coll: fc, kinds, store: lazyStore(scope), listen, apply: tombsFor(scope), now, onError, stampMode, serverField }));
      }
      clearTimeout(timers.get(k)); timers.delete(k);
      const off = e.subscribe(cb);
      return () => {
        off();
        if (e.size || engines.get(k) !== e) return;
        clearTimeout(timers.get(k));
        timers.set(k, setTimeout(() => {
          timers.delete(k);
          if (e.size || engines.get(k) !== e) return;
          end(k, e); idle(scope);
        }, grace));
      };
    },
    // records deleted on this device (for good, or into the bin)
    /** @param {string} scope @param {string} coll @param {string[]} ids @returns {Promise<void>} */
    drop(scope, coll, ids) {
      if (!ids || !ids.length) return Promise.resolve();
      const e = engines.get(key(scope, coll));
      return (e ? e.drop(ids) : storeTombs(scope, coll, ids, true)).catch((/** @type {any} */ err) => console.warn('Local store not updated', err));
    },
    // deferred tombstones (0.6.3): apply those of scope whose record's saves are done (call when the queue changes)
    /** @param {string} scope */
    async settle(scope) {
      const runs = [];
      for (const [k, e] of engines) if (k.startsWith(scope + '\n') && e.waiting().length) runs.push(e.settle());
      const idle = new Set([...waiting].filter(w => w.startsWith(scope + '\n')).map(w => w.split('\n')[1]).filter(c => !engines.has(key(scope, c))));
      for (const coll of idle) {
        for (const w of [...waiting]) if (w.startsWith(key(scope, coll) + '\n')) waiting.delete(w);
        runs.push(storeTombs(scope, coll, []));
      }
      await Promise.all(runs.map(p => p.catch((/** @type {any} */ err) => console.warn('Local store not updated', err))));
    },
    // the highest tombstone known on this device for a record (ms; 0: none), from its running engine
    /** @param {string} scope @param {string} coll @param {any} id */
    tomb(scope, coll, id) { const e = engines.get(key(scope, coll)); return e ? e.tomb(String(id)) : 0; },
    // stop everything and forget open stores (sign-out); resolves when pending local writes are done
    async stopAll() {
      for (const t of timers.values()) clearTimeout(t);
      const waits = [...[...engines.values(), ...feeds.values()].map(x => x.stop()), ...stopping.values()];
      engines.clear(); feeds.clear(); stores.clear(); timers.clear(); stopping.clear(); waiting.clear();
      await Promise.all(waits).catch(() => {});
    },
    // (1.3.0) stop one scope's engines now, unwatched or not (a public scope, listened again under the account)
    /** @param {string} scope @returns {Promise<void>} */
    async stopScope(scope) {
      const waits = [];
      for (const [k, e] of [...engines]) if (k.startsWith(scope + '\n')) { clearTimeout(timers.get(k)); timers.delete(k); waits.push(end(k, e)); }
      idle(scope);
      await Promise.all(waits).catch(() => {});
    },
    // the page woke (shown again, back online): every engine due a full read starts it. -> how many restarted
    replan() { return [...engines.values(), ...feeds.values()].filter(x => x.replan()).length; },
    // tests: wait for pending local writes
    flush: () => Promise.all([...[...engines.values(), ...feeds.values()].map(x => x.flush()), ...[...tombing.values()].map(p => p.catch(() => {}))]),
  };
  landers.set(hub, (scope, coll, doc) => {
    const e = engines.get(key(scope, coll));
    return e ? e.land(doc).catch((/** @type {any} */ err) => console.warn('Local store not updated', err)) : Promise.resolve();
  });
  return hub;
}

// Call hub.replan() when the page is shown again, the browser comes back online, and every `every` ms while the page
// is shown (a page that stays visible for days never wakes). -> a function that stops it.
/**
 * @param {{ replan: () => number }} hub
 * @param {any} [win]
 * @param {{ every?: number }} [options]
 * @returns {() => void} stops it
 */
export function replanOnWake(hub, win = typeof window !== 'undefined' ? window : null, { every = REPLAN_EVERY } = {}) {
  if (!win || !win.addEventListener) return () => {};
  const doc = win.document;
  const wake = () => { if (!doc || doc.visibilityState !== 'hidden') hub.replan(); };
  win.addEventListener('online', wake);
  win.addEventListener('pageshow', wake);
  if (doc) doc.addEventListener('visibilitychange', wake);
  const timer = every > 0 ? setInterval(wake, every) : null;
  /** @type {any} */ (timer)?.unref?.();   // (never keeps a test process alive)
  return () => { win.removeEventListener('online', wake); win.removeEventListener('pageshow', wake); if (doc) doc.removeEventListener('visibilitychange', wake); if (timer) clearInterval(timer); };
}
