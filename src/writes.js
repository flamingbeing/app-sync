// The write queue: every save goes to a durable outbox on this device first (outbox.js), then to the backend, one
// record at a time and in order. A save that fails or meets a change made elsewhere (a conflict) is kept, never
// expires and never blocks a later save made on the version shown; another window on the device sharing the outbox
// is taken into account before anything is sent again.
//
// createWriteQueue({ store, backend, getOwner, normalize, online, delay, notice, sendTimeout, labels, otherPending, registry, report })
//   store: the outbox ({ put, list, get, remove, forget }). backend(owner, kind, record, base) -> result; throws
//   { code: 'write-conflict', remote } (conflict.js checkWrite), a transient error ('unavailable',
//   'deadline-exceeded', 'aborted': stays pending, retried with backoff) or any other error (failed). sendTimeout: a
//   backend call that doesn't settle in this time counts as transient, so one stuck call never holds a record's saves
//   for good. otherPending: async () -> truthy while writes sent another way (not through this queue) are not on the
//   server yet; it keeps the sign-out check (flush) shut, as does a throw (can't tell). registry: the origin's outbox
//   registry (registry.js), for apps that share sign-in on one origin: flush also refuses while another registered
//   outbox has unsent saves for this user, and forget forgets this user in all of them.
//   report: the nothing-lost report (report.js), opt-in: the queue's entries are counted and each failed send counts
//   one error by its code (only the code; nothing else of the error or the save).
//   ignore: top-level fields left out when this queue compares versions (0.6.3; default none), for the engine's own
//   fields an app's copies don't carry (createApp passes them with held conflicts: who changed what, save keys).
// save(kind, owner, record, base, { ops }): ops (optional) describe the change for a backend that applies changes by
//   field (a last-write-wins collection: increments, keyed updates). They are stored with the save and handed on as
//   backend(owner, kind, record, base, { key, ops: [ops, …] }), key the save's own id (a backend can use it to apply
//   a save only once); a failed save replaced by a newer one passes its ops on first, so no change is lost.
//   meta (0.8.2, optional): the app's own data about the save (a row, a label), stored with the job and returned by
//   entries() and finished(key), after a reload too.
// Refused saves (0.8.2): a failed save keeps the error's code on the job (code), after a reload too. refused(kind?) ->
//   the saves the server refused that wait for the user: failed ones, and ones set aside with archive(key,
//   { refused: true }) (state archived with refused: true, so every version's sign-out gate counts them finished;
//   kept out of the history's pruning until discarded or sent). retry(key) sends a refused save again; discard(key)
//   gives it up (it stays in the history as an ordinary set-aside save). Until then it keeps flush() (the sign-out
//   gate) false, here and through the registry: the outbox is its only copy.
// finished(key) (0.8.2) -> the job once synced or archived (meta included), null while it is not (or not on this
//   device). lastSent(kind, id) (0.8.2) -> { stamp, signature } of the copy this device last sent of that record
//   (what the backend answered it stored, else the record sent; stamp: its field, option field = 'updatedAt';
//   signature: conflict.js recordSignature, without the option engine's fields, e.g. serverAt), null
//   when none is in the device history (the last 100 finished saves): after a reload too.
//
// watchSaved({ hub, queue, scope, coll, kind, owner = scope }, cb) -> unsubscribe (0.5.2): the engine's list of coll
//   (hub.watch) with this device's saves of kind laid over it (queue.overlay), handed to cb(list, meta) whenever either
//   changes. Use it, not hub.watch with overlay inside: a save's own copy shows while it is sent, and the listener may
//   hear the server's copy (with another device's change in it) during that time; once the save is done, only a queue
//   change says so, and the server's copy must show then though the listener hears nothing new.
//   A save shows from the moment save() is called (0.7.2), before it is stored or accepted.
//   meta (0.8.2) also says { changed, removed }: the ids whose copy differs from the last list handed (all, the first
//   time) and the ids no longer in it. The returned function also has copyOf(id) (the copy last handed) and seen(id)
//   (the engine's copy, without this device's saves laid over it).
import { recordSignature } from './conflict.js';

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').JobState} JobState
 * @typedef {import('./types.js').CodedError} CodedError
 * @typedef {import('./types.js').QueueOptions} QueueOptions
 */

/** @template T @param {T} value @returns {T} */
const copy = value => JSON.parse(JSON.stringify(value));
/** @param {{ kind: string, record: Doc }} job */
const keyOf = job => job.kind + ':' + job.record.id;
const terminal = new Set(['synced', 'archived']);
const KEEP = 100;   // finished saves kept in the device history (the app's history view)
// the network dropped mid-save (Firestore: 'unavailable', 'deadline-exceeded'), or another device's transaction on the
// same record won the race ('aborted'): the job stays pending and tries again
/** @param {any} error */
const transient = error => error?.code === 'unavailable' || error?.code === 'deadline-exceeded' || error?.code === 'aborted';
export const SEND_TIMEOUT = 30000;
// Stored format (FORMATS.md): every new job carries v: JOB_FORMAT (jobs without v were written before 0.8.0, same
// shape). Mixed versions share an origin's outboxes, so states are fixed: no new state before 2.0.
export const JOB_FORMAT = 1;
export const JOB_STATES = Object.freeze(['pending', 'synced', 'failed', 'conflict', 'archived']);
/** @param {QueueOptions} options */
export function createWriteQueue({ store, backend, getOwner = () => null, normalize = (_kind, value) => value, online = () => true, delay = ms => new Promise(r => setTimeout(r, ms)), notice = () => {}, sendTimeout = SEND_TIMEOUT, labels = {}, otherPending = null, registry = null, report = null, ignore = [], field = 'updatedAt', engine = [] }) {
  if (!store) throw new Error('createWriteQueue needs a store (the outbox)');
  /** @param {any} v */
  const bare = v => { if (!ignore.length || !v || typeof v !== 'object') return v; const out = { ...v }; for (const f of ignore) delete out[f]; return out; };
  /** @param {any} v */
  const signature = v => recordSignature(bare(v));
  /** @param {any} a @param {any} b */
  const same = (a, b) => signature(a) === signature(b);
  const recover = labels.recover || 'Recover';
  /** @param {Job} job */
  const failure = job => new Error(new RegExp('in ' + recover + '\\b').test(job.error) ? job.error : job.error + ' — a copy is kept in ' + recover);
  // a backend call that never settles counts as a dropped connection after sendTimeout (it may still land: sending
  // the same content again is harmless, checkWrite sees it is already there)
  /** @param {Parameters<import('./types.js').QueueBackend>} args */
  const send = (...args) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => { const e = /** @type {CodedError} */ (new Error('The server did not answer in time')); e.code = 'deadline-exceeded'; reject(e); }, sendTimeout); });
    return Promise.race([Promise.resolve().then(() => backend(...args)), late]).finally(() => clearTimeout(timer));
  };
  /** @type {string | null} */
  let owner = null;
  /** @type {Job[]} */
  let jobs = [];
  /** @type {Promise<void> | null} */
  let loading = null;
  let generation = 0, storageError = '';
  /** @type {Map<string, Promise<any>>} */
  const running = new Map();
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {Map<string, { tries: number, timer?: object | null }>} */
  const waits = new Map();
  const notify = () => { for (const fn of listeners) fn(); };
  /** @type {Map<string, { kind: string, owner: string, record: Doc }>} */
  const inflight = new Map();   // saves called but not stored yet (overlay shows them)
  /** @param {string | null} email @param {number} gen */
  const current = (email, gen) => owner === email && generation === gen && getOwner() === email;
  // sorted again only when the list changes (a job's at and key never do; callers never change it in place): overlay
  // asks once per record, and sorting on every call made a change to a few hundred records take seconds
  /** @type {Job[]} */
  let sorted = [];
  /** @type {Job[] | null} */
  let sortedFrom = null;
  let sortedLength = 0;
  const ordered = () => {
    if (sortedFrom !== jobs || sortedLength !== jobs.length) { sorted = [...jobs].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key)); sortedFrom = jobs; sortedLength = jobs.length; }
    return sorted;
  };
  // a record's saves not yet done with, oldest first: only the first is ever sent
  /** @param {string} id */
  const chainOf = id => ordered().filter(x => keyOf(x) === id && !terminal.has(x.state));
  /** @param {Job} job */
  async function persist(job) { await store.put(copy(job)); }
  // Another window on this device (a second tab, or the home-screen app beside the browser) shares the store and may
  // have sent or set aside a job since this one read it: what it stored wins, or this window sends its stale copy
  // later (a case deleted there comes back, one restored there is deleted again). Two windows sending one job at the
  // same moment is harmless (checkWrite: same content); no Web Lock, which a frozen background window would hold.
  // -> true when the job moved on
  /** @param {Job} job */
  async function refresh(job) {
    let stored;
    try { stored = await store.get(job.key); } catch { return false; }   // unreadable: carry on as before
    // Not there: another window finished it and later pruned it (KEEP newer finished ones are then there), or the
    // browser cleared the site's storage (this window's copy may be the only one, so it goes)
    if (!stored) {
      let newer = 0;
      try { newer = (await store.list(job.owner)).filter(x => terminal.has(x.state) && x.at >= job.at).length; } catch { return false; }
      if (newer < KEEP) return false;
      job.state = 'archived'; jobs = jobs.filter(x => x !== job); return true;
    }
    if (stored.state === job.state || stored.state === 'pending') return false;
    Object.assign(job, { state: stored.state, error: stored.error || '', result: stored.result, remote: stored.remote, accepted: stored.accepted, kept: stored.kept, code: stored.code, refused: stored.refused });
    return true;
  }
  /** @param {string} id @returns {Promise<void>} */
  async function drain(id) {
    if (running.has(id)) return running.get(id);
    const email = owner, gen = generation;
    const task = (async () => {
      while (true) {
        const job = chainOf(id)[0];
        if (!job || !current(email, gen) || !online() || job.state !== 'pending') break;
        const moved = await refresh(job);
        if (!current(email, gen)) return;
        if (moved) { notify(); continue; }
        try {
          const result = await send(email, job.kind, copy(job.record), copy(job.base), { key: job.key, ...(job.ops ? { ops: copy(job.ops) } : {}) });
          if (!current(email, gen)) return;
          job.result = copy(result); job.state = 'synced'; job.error = ''; delete job.code;
        } catch (error) {
          if (!current(email, gen)) return;
          // set aside while it was being sent (a save made on the other copy took its place): it stays so, the next goes
          if (/** @type {JobState} */ (job.state) === 'archived') continue;   // (state changes while the send is awaited)
          if (report) { try { report.error(error?.code); } catch { /* a report never stops a save */ } }
          if (transient(error)) { job.error = 'Waiting for the connection'; retryLater(id, email, gen); notify(); break; }
          job.state = error.code === 'write-conflict' ? 'conflict' : 'failed';
          job.error = error.message || 'Could not save'; job.code = String(error?.code || '');
          if (error.remote !== undefined) job.remote = copy(error.remote);
        }
        try { await persist(job); } catch (error) { storageError = error.message; if (report) { try { report.error('outbox-write'); } catch { /* never stops a save */ } } }
        notify();
        if (job.state !== 'synced') break;
        waits.delete(id);
      }
      // Keep a short device history; failed/conflicting/pending records never expire here, nor this device's own
      // versions set aside by a save made on the other copy (kept)
      const old = ordered().filter(x => terminal.has(x.state) && !x.kept && !x.refused).slice(0, -KEEP);
      for (const job of old) { await store.remove(job.key); jobs = jobs.filter(x => x !== job); }
    })().finally(() => {
      if (running.get(id) !== task) return;
      running.delete(id);
      if (current(email, gen) && online() && !waits.get(id)?.timer && chainOf(id)[0]?.state === 'pending') void drain(id).catch(error => { storageError = error.message; notify(); });
    });
    running.set(id, task); return task;
  }
  // back off 2 s, 4 s … up to a minute; going online (kick) tries at once
  /** @param {string} id @param {string | null} email @param {number} gen */
  function retryLater(id, email, gen) {
    const wait = waits.get(id) || { tries: 0 }; wait.tries++; waits.set(id, wait);
    const timer = wait.timer = {};
    delay(Math.min(60000, 1000 * 2 ** wait.tries)).then(() => {
      if (wait.timer !== timer) return; wait.timer = null;
      if (current(email, gen)) void drain(id).catch(error => { storageError = error.message; notify(); });
    });
  }
  /** @param {string} email */
  async function activate(email) {
    if (owner === email && loading) return loading;
    owner = email; const gen = ++generation; jobs = []; running.clear(); waits.clear(); storageError = '';
    loading = (async () => {
      try { const found = await store.list(email); if (current(email, gen)) jobs = found; }
      catch (error) { if (current(email, gen)) storageError = error.message; }
      if (current(email, gen)) { notify(); kick(); }
    })();
    return loading;
  }
  function kick() { for (const wait of waits.values()) wait.timer = null; if (owner && getOwner() === owner) for (const id of new Set(jobs.map(keyOf))) void drain(id).catch(error => { storageError = error.message; notify(); }); }
  /**
   * @param {string} kind
   * @param {string} email
   * @param {Doc} record
   * @param {Doc | null} [base]
   * @param {{ ops?: any, meta?: any }} [options]
   * @returns {Promise<Doc>}
   */
  async function save(kind, email, record, base = null, { ops, meta } = {}) {
    record = copy(normalize(kind, copy(record))); base = copy(base);
    if (getOwner() !== email) throw new Error('Account changed; the editor has not been saved');
    // shown at once (0.7.2): the lists have this save from now, before it is stored, until its job takes over
    const early = { kind, owner: email, record: copy(record) }, earlyKey = kind + ':' + record.id;
    inflight.set(earlyKey, early); notify();
    const unshow = () => { if (inflight.get(earlyKey) !== early) return false; inflight.delete(earlyKey); return true; };
    try { return await saveNow(kind, email, record, base, ops, meta, unshow); }
    finally { if (unshow()) notify(); }
  }
  /** @param {string} kind @param {string} email @param {Doc} record @param {Doc | null} base @param {any} ops @param {any} meta @param {() => boolean} unshow @returns {Promise<Doc>} */
  async function saveNow(kind, email, record, base, ops, meta, unshow) {
    await activate(email); const gen = generation, id = kind + ':' + record.id;
    let moved = false;
    for (const x of chainOf(id)) moved = await refresh(x) || moved;
    if (!current(email, gen)) throw new Error('Account changed; the editor has not been saved');
    if (moved) notify();
    const chain = chainOf(id), previous = chain.at(-1), conflict = chain.find(x => x.state === 'conflict');
    // After a conflict nothing more is sent until the user chooses a version: a later save would otherwise wait behind
    // it for good, saying 'Saved locally', and either conflict choice would set it aside. Made on the other copy
    // (the version shown), it takes the stopped chain's place; unchanged, it changes nothing (opening a record is no
    // choice). Made on this device's own version, it is kept as one more conflict and fails, so the editor keeps it.
    const over = !!conflict && same(base, conflict.remote), held = !!conflict && !over;
    if (over && base && same(record, normalize(kind, copy(base)))) return copy(record);   // (both as the editor saves them)
    // a failed save, or a held copy (never sent), is replaced by the next one
    const stale = !over && previous && (previous.state === 'failed' || held && previous.state === 'conflict' && previous !== chain[0]) ? previous : null;
    /** @type {Job} */
    let job;
    if (stale && same(stale.record, record)) {
      job = stale; if (!held) { job.state = 'pending'; job.error = ''; delete job.code; }
      if (meta !== undefined) job.meta = copy(meta);
    } else {
      job = { v: JOB_FORMAT, key: email + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2), owner: email,
        kind, record: copy(record), base: copy(stale?.state === 'failed' ? stale.base : base), state: held ? 'conflict' : 'pending', accepted: false, at: Math.max(Date.now(), ...jobs.map(x => x.at + 1)) };
      if (held) { job.remote = copy(conflict.remote ?? null); job.error = conflict.error; }
      const carried = stale && (stale.state === 'failed' || held) ? stale.ops || [] : [];   // (a held copy's ops too: 0.7.1)
      if (ops !== undefined || carried.length) job.ops = [...carried, ...(ops !== undefined ? [copy(ops)] : [])];
      if (meta !== undefined) job.meta = copy(meta);
    }
    try { await persist(job); storageError = ''; }
    catch { storageError = 'Local storage is unavailable. Your input has not been cleared.'; notify(); throw new Error(storageError); }
    if (!current(email, gen)) throw new Error('Account changed; the editor has not been saved');
    // set aside once the new save is stored: the one it replaces, or (made on the other copy) the whole stopped chain,
    // kept in the history for good, and the user told
    for (const x of over ? chain : stale && stale !== job ? [stale] : []) { x.state = 'archived'; if (over) x.kept = true; await persist(x); }
    if (!jobs.includes(job)) jobs.push(job);
    unshow(); notify();
    if (over && !same(previous.record, record)) notice('Your version from this device is kept in ' + recover);
    if (held) throw failure(job);
    await Promise.race([drain(keyOf(job)), delay(180)]);
    if (!current(email, gen)) throw new Error('Account changed; the editor has not been saved');
    if (job.state === 'failed' || job.state === 'conflict') throw failure(job);
    job.accepted = true; await persist(job); notify();
    return copy(job.result || job.record);
  }
  // Restoring a version (from the app's history or conflict screen). After a conflict it is saved over the other copy (the first conflict's, which save()
  // checks); behind a failed save, from what the server holds, that save's base (made from the list's copy it waited
  // behind the failed one for good). Either way the stopped chain is set aside only once the
  // new save is stored (after a conflict save() does it, unless this is the other copy unchanged). A failed save on its
  // own, save() replaces itself.
  /** @param {string} kind @param {string} email @param {Doc} record @param {Doc | null} [base] */
  async function restore(kind, email, record, base = null) {
    if (getOwner() !== email) throw new Error('Account changed; the editor has not been saved');
    await activate(email); const id = kind + ':' + record.id;
    for (const x of chainOf(id)) if (await refresh(x)) notify();
    const chain = chainOf(id), conflict = chain.find(x => x.state === 'conflict');
    const stuck = !conflict && chain.length > 1 && chain[0].state === 'failed';
    const saved = await save(kind, email, record, conflict ? conflict.remote ?? null : stuck ? chain[0].base ?? null : base);
    if (conflict || stuck) await archive(chain.at(-1).key);
    return saved;
  }
  /** @param {string} kind @param {string} email @param {Doc[]} list @returns {Doc[]} */
  function overlay(kind, email, list) {
    if (email !== owner) return list;
    const result = new Map(list.map(r => [r.id, r]));
    const early = [...inflight.values()].filter(x => x.kind === kind && x.owner === email);
    for (const id of new Set([...jobs.filter(x => x.kind === kind).map(x => x.record.id), ...early.map(x => x.record.id)])) {
      const group = chainOf(kind + ':' + id), conflicts = group.filter(x => x.state === 'conflict');
      if (conflicts.length) {
        // The list is the server's copy (the sync engine), so an edit or delete made elsewhere since the conflict shows
        // (not the stale copy found at the conflict). That copy shows only while
        // the list still has this device's own unsynced version, or the very one it started from (a stale cached list;
        // the same content saved again elsewhere, as by a restore, has a newer stamp), or its delete took it off.
        const cur = result.get(id), sig = signature(cur || null);
        /** @param {Job} x */
        const started = x => signature(x.base) === sig && (x.base?.updatedAt ?? null) === (cur.updatedAt ?? null);
        if (cur ? group.some(x => signature(x.record) === sig || started(x)) : group.some(x => x.record._deleted)) {
          const { remote } = conflicts[0]; if (remote) result.set(id, remote); else result.delete(id);
        } else if (cur) for (const x of conflicts) if (signature(x.remote) !== sig) x.remote = copy(cur);   // the conflict's other copy
      } else {
        // this device's newest save of it: one being stored now, else the newest job not done (0.7.2: also while its
        // save() has not returned yet, so a list handed in that time has it; a save failed at once leaves again)
        const now = inflight.get(kind + ':' + id), latest = now && now.owner === email ? now : group.filter(x => x.accepted || x.state === 'pending').at(-1);
        if (latest) { if (latest.record._deleted) result.delete(id); else result.set(id, latest.record); }
      }
    }
    return [...result.values()];
  }
  /** @param {string} key */
  async function retry(key) {
    let job = jobs.find(x => x.key === key); const email = owner, gen = generation;
    if (!job || getOwner() !== owner || job.state === 'conflict') return;
    if (await refresh(job)) notify();
    if (!current(email, gen)) return;
    // set aside as refused (0.8.2): back in its record's chain, in its own place (a newer save made since meets it as
    // a change made elsewhere: the conflict check, never an overwrite)
    if (job.state === 'archived' && job.refused) { job.state = 'failed'; delete job.refused; }
    if (job.state !== 'failed' && job.state !== 'pending') return;
    const head = chainOf(keyOf(job))[0];
    if (head?.state === 'conflict') throw new Error('An earlier save of this record met a change made elsewhere: choose a version there first');
    // waiting behind a failed save (Retry did nothing): that one is sent again first
    if (head && head !== job && head.state === 'failed') { if (await refresh(head)) notify(); if (!current(email, gen)) return; if (head.state === 'failed') job = head; }
    job.state = 'pending'; job.error = ''; delete job.code; await persist(job); notify(); await drain(keyOf(job));
  }
  // sets aside that save and older ones, never a newer save (it is sent next, or meets the conflict again); from a
  // conflict also the held copies behind it (never sent, the same conflict), or the record needs a second tap
  // (0.8.2) refused: a save the server refused, set aside until the user retries or discards it
  /** @param {string} key @param {{ refused?: boolean }} [options] */
  async function archive(key, { refused = false } = {}) {
    const job = jobs.find(x => x.key === key); if (!job || getOwner() !== owner) return;
    const chain = chainOf(keyOf(job)), upto = chain.indexOf(job);
    for (const item of chain.filter((x, i) => i <= upto || upto >= 0 && job.state === 'conflict' && x.state === 'conflict')) {
      if (refused && item.state === 'failed') item.refused = true;
      item.state = 'archived'; await persist(item);
    }
    notify();
    void drain(keyOf(job)).catch(error => { storageError = error.message; notify(); });
  }
  // a refused save given up (0.8.2): set aside for good, an ordinary entry of the history
  /** @param {string} key */
  async function discard(key) {
    const job = jobs.find(x => x.key === key); if (!job || getOwner() !== owner) return;
    if (job.state === 'archived') { if (!job.refused) return; delete job.refused; await persist(job); notify(); return; }
    await archive(key);
  }
  async function forget() {
    const old = owner; owner = null; ++generation; loading = null; jobs = []; running.clear(); waits.clear(); storageError = ''; notify();
    if (!old) return;
    let error = null;
    try { await store.forget(old); } catch (e) { error = e; }
    if (registry) { try { await registry.forget(old, { except: store }); } catch (e) { error ||= e; } }
    if (error) throw error;
  }
  const api = { activate, save, restore, overlay, retry, archive, discard, forget, kick,
    /** @param {Partial<QueueOptions>} config */
    configure(config) { if (config.backend) backend = config.backend; if (config.getOwner) getOwner = config.getOwner; if (config.normalize) normalize = config.normalize; if (config.notice) notice = config.notice; },
    /** @param {() => void} fn */
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    entries: () => copy(ordered()).reverse(),
    pending: () => jobs.filter(x => !terminal.has(x.state)).length,
    // a save needs the user (failed, or met a change made elsewhere), without copying every entry as entries() does
    /** @param {string} [kind] */
    attention: kind => jobs.some(x => (!kind || x.kind === kind) && (x.state === 'failed' || x.state === 'conflict')),
    // a change made elsewhere stopped this record's saves: nothing more of it is sent until the user chooses
    // this record has saves not sent yet (pending, failed or in conflict): for the engine's unsent option
    /** @param {string} kind @param {string} id */
    unsent: (kind, id) => jobs.some(x => x.kind === kind && x.record.id === id && !terminal.has(x.state)),
    /** @param {string} kind @param {string} id */
    conflicted: (kind, id) => jobs.some(x => x.kind === kind && x.record.id === id && x.state === 'conflict'),
    // -> true once none of these records is being sent (false after ms): what became of each save is known then
    // (synced, conflict, failed, or pending: offline or waiting to retry), not only that it was stored, which is all
    // save() waits for after 180 ms; a slow connection finds a change made elsewhere later than that
    /** @param {string} kind @param {string[]} ids @param {number} [ms] */
    async settle(kind, ids, ms = 10000) {
      const keys = ids.map(id => kind + ':' + id), busy = () => keys.map(k => running.get(k)).filter(Boolean);
      const idle = async () => { for (let now; (now = busy()).length;) await Promise.allSettled(now); return true; };
      return Promise.race([idle(), delay(ms).then(() => false)]);
    },
    async flush(ms = 4000) {
      kick(); await Promise.race([Promise.all([...running.values()]), delay(ms)]);
      // (0.8.2) a refused save set aside is not given up either: kept until the person retries or discards it
      if (jobs.some(x => !terminal.has(x.state) || x.refused)) return false;
      // writes the app sends another way (straight to the SDK) and not yet on the server
      if (otherPending) { try { if (await otherPending()) return false; } catch { return false; } }
      // the other apps on this origin (they share sign-in): their unsent saves for this user
      const who = owner || getOwner();
      if (registry && who) { try { if (await registry.unsent(who, { except: store })) return false; } catch { return false; } }
      // changes another tab (or the home-screen app) has not synced yet are in the same store: signing out deletes them
      if (!owner) return true;
      // (the shared outbox can't be read: not known to be empty, so the sign-out gate stays shut)
      try { const mine = new Set(jobs.map(x => x.key)); return !(await store.list(owner)).some(x => !mine.has(x.key) && (!terminal.has(x.state) || x.refused)); }
      catch { return false; }
    },
    error: () => storageError,
    /** @param {string} kind @param {string} id */
    status(kind, id) { return [...ordered()].reverse().find(x => x.kind === kind && x.record.id === id)?.state || ''; },
    // one job followed through (a later save of the same record is another job): the latest job's key, and a job's state
    /** @param {string} kind @param {string} id */
    jobKey(kind, id) { return [...ordered()].reverse().find(x => x.kind === kind && x.record.id === id)?.key || ''; },
    /** @param {string} key */
    stateOf(key) { return jobs.find(x => x.key === key)?.state || ''; },
    // (0.8.2) the saves the server refused that wait for the user, newest first
    /** @param {string} [kind] @returns {Job[]} */
    refused: kind => copy(ordered().filter(x => (!kind || x.kind === kind) && (x.state === 'failed' || x.state === 'archived' && x.refused))).reverse(),
    /** @param {string} key @returns {Job | null} */
    finished(key) { const job = jobs.find(x => x.key === key); return job && terminal.has(job.state) ? copy(job) : null; },
    /** @param {string} kind @param {string} id @returns {{ stamp: any, signature: string } | null} */
    lastSent(kind, id) {
      const job = [...ordered()].reverse().find(x => x.kind === kind && x.record.id === id && x.state === 'synced');
      if (!job) return null;
      // what the server stored (a merge may hold more than was sent), without the engine's own fields
      const doc = job.result && typeof job.result === 'object' && 'id' in job.result ? job.result : job.record;
      const out = { ...bare(doc) }; for (const f of engine) delete out[f];
      return { stamp: doc[field] ?? null, signature: recordSignature(out) };
    },
  };
  if (report) { try { report.watch(api); } catch { /* a report never stops the queue */ } }
  return api;
}

/**
 * @param {{ hub: { watch: (scope: string, coll: string, cb: (list: Doc[], meta: import('./types.js').SnapMeta) => void) => () => void },
 *   queue: ReturnType<typeof createWriteQueue>, scope: string, coll: string, kind: string, owner?: string }} options
 * @param {(list: Doc[], meta: import('./types.js').WatchMeta) => void} cb
 * @returns {(() => void) & { copyOf: (id: string) => Doc | null, seen: (id: string) => Doc | null }}
 */
export function watchSaved({ hub, queue, scope, coll, kind, owner = scope }, cb) {
  /** @type {Doc[] | null} */
  let list = null;
  /** @type {import('./types.js').SnapMeta | null} */
  let meta = null;
  /** @type {string | null} */
  let sent = null;
  let live = true;
  // what was handed last, by id (as text: a copy nobody can change), for changed/removed and copyOf (0.8.2)
  /** @type {Map<string, string>} */
  let last = new Map();
  /** @param {boolean} force */
  const hand = force => {
    if (!live || !list) return;
    const shown = queue.overlay(kind, owner, list), texts = shown.map(d => JSON.stringify(d)), sig = '[' + texts.join(',') + ']';
    if (!force && sig === sent) return;
    sent = sig;
    /** @type {Map<string, string>} */
    const now = new Map();
    /** @type {string[]} */
    const changed = [], removed = [];
    shown.forEach((d, i) => { const id = String(d.id); now.set(id, texts[i]); if (last.get(id) !== texts[i]) changed.push(id); });
    for (const id of last.keys()) if (!now.has(id)) removed.push(id);
    last = now;
    cb(copy(shown), { ...meta, changed, removed });
  };
  const offQueue = queue.onChange(() => hand(false));
  const offHub = hub.watch(scope, coll, (l, m) => { list = l; meta = m; hand(true); });
  return Object.assign(() => { live = false; offQueue(); offHub(); }, {
    /** @param {string} id */
    copyOf: id => { const t = last.get(String(id)); return t === undefined ? null : JSON.parse(t); },
    /** @param {string} id */
    seen: id => { const d = list?.find(x => String(x.id) === String(id)); return d ? copy(d) : null; },
  });
}
