// Concurrency checks for the write queue (writes.js) and a backend's commit.

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').CodedError} CodedError
 * @typedef {import('./types.js').HeldSave} HeldSave
 * @typedef {import('./types.js').ConflictChoice} ConflictChoice
 * @typedef {import('./types.js').ConflictView} ConflictView
 * @typedef {{ counters?: string[], skip?: string[] }} MergeOptions
 */

// Pure equality: key order and updatedAt are ignored (a backend refreshes updatedAt on save), so identical content
// sent again after a lost acknowledgement is idempotent.
/** @param {any} record @returns {string} */
export function recordSignature(record) {
  /** @type {(value: any) => any} */
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(k => k !== 'updatedAt').map(k => [k, sort(value[k])])) : value;
  return JSON.stringify(sort(record || null));
}

// current: the server's copy now; desired: what this device sends (null: a delete); base: the copy the edit started
// from. -> false: nothing to write (already there); true: write it. Throws { code: 'write-conflict', remote } when
// the record changed elsewhere since base: both versions are kept, nothing is overwritten.
/**
 * @param {Doc | null} current
 * @param {Doc | null} desired
 * @param {Doc | null} base
 * @param {string} [message]
 * @returns {boolean}
 */
export function checkWrite(current, desired, base, message = 'This record changed elsewhere; both versions are kept') {
  if (recordSignature(current) === recordSignature(desired)) return false;
  if (recordSignature(current) !== recordSignature(base)) {
    const error = /** @type {CodedError} */ (new Error(message));
    error.code = 'write-conflict'; error.remote = current || null; throw error;
  }
  return true;
}

// Last-write-wins by field, for collections that need no conflict screen: what this device changed since base wins,
// everything else keeps what the server holds now (current). Plain objects are merged key by key, so two devices
// changing different keys of one map both keep their change; arrays and other values are replaced whole. A key the
// record no longer has (but base had) is removed. Without a base (not known here yet), every field sent is merged into
// current. updatedAt is the backend's (ignored here). -> the merged record (current is not changed)
/** @param {any} v @returns {v is Record<string, any>} */
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** @template T @param {T} v @returns {T} */
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
/**
 * @param {Doc | null} current
 * @param {Doc | null} record
 * @param {Doc | null} base
 * @returns {Doc}
 */
export function mergeFields(current, record, base) {
  /** @type {(cur: any, rec: any, was: any) => any} */
  const merge = (cur, rec, was) => {
    const out = isMap(cur) ? clone(cur) : {};
    for (const k of new Set([...Object.keys(rec), ...Object.keys(was)])) {
      if (k === 'updatedAt' || recordSignature(rec[k] ?? null) === recordSignature(was[k] ?? null) && k in rec === k in was) continue;
      if (!(k in rec)) delete out[k];
      else if (isMap(rec[k]) && (was[k] === undefined || isMap(was[k]))) out[k] = merge(out[k], rec[k], was[k] || {});
      else out[k] = clone(rec[k]);
    }
    return out;
  };
  return merge(current, record || {}, base || {});
}

// Held conflicts by field (0.6.3, opt-in: the Firestore adapter's `held` option). A 3-way merge of what this device
// changed since base into the server's copy now (current), field by field:
//   - a field only this device changed takes its value; one only changed elsewhere keeps the server's;
//   - a field both changed to the same value is no conflict (nothing to ask);
//   - a counter (a field in counters, holding numbers) takes this device's change as an increment, so two devices
//     adding to it both count; never a conflict;
//   - plain objects are merged key by key, the same way;
//   - a field both changed to different values is a clash: nothing is written and it throws { code: 'write-conflict',
//     remote: current, fields: [paths] } (a path is the field's keys joined with '.'), so the queue holds the save
//     for the user to choose. With pick(path) -> 'mine' | 'theirs', a clash takes that side instead (resolving it).
// skip: top-level fields left out (stamps, the engine's own fields): the server's are kept. Without a base (a record
// this device has not seen), every field it sends counts as changed. -> the merged record (current is not changed)
/**
 * @param {Doc | null} current
 * @param {Doc | null} record
 * @param {Doc | null} base
 * @param {MergeOptions & { pick?: ((path: string) => 'mine' | 'theirs') | null }} [options]
 * @returns {Doc}
 */
export function mergeHeld(current, record, base, { counters = [], skip = [], pick = null } = {}) {
  /** @param {any} a @param {any} b */
  const sameValue = (a, b) => recordSignature(a ?? null) === recordSignature(b ?? null);
  const counter = new Set(counters), skipped = new Set(['updatedAt', ...skip]);
  /** @type {string[]} */
  const clashes = [];
  /** @type {(cur: any, rec: any, was: any, prefix: string) => any} */
  const merge = (cur, rec, was, prefix) => {
    const out = isMap(cur) ? clone(cur) : {}, now = isMap(cur) ? cur : {};
    for (const k of new Set([...Object.keys(rec), ...Object.keys(was)])) {
      if (!prefix && skipped.has(k)) continue;
      const path = prefix + k, mine = k in rec, had = k in was, there = k in now;
      if (mine === had && sameValue(rec[k], was[k])) continue;                       // not changed here
      if (counter.has(path) && typeof (rec[k] ?? 0) === 'number' && typeof (was[k] ?? 0) === 'number') {
        out[k] = (typeof now[k] === 'number' ? now[k] : 0) + (rec[k] ?? 0) - (was[k] ?? 0);   // (before the same-value
        continue;                                                                             // check: 3→4 on both is 5)
      }
      if (mine === there && sameValue(rec[k], now[k])) continue;                     // already so (same value)
      const take = () => { if (mine) out[k] = clone(rec[k]); else delete out[k]; };
      if (had === there && sameValue(now[k], was[k])) { take(); continue; }          // changed here only
      if (mine && isMap(rec[k]) && isMap(now[k]) && (!had || isMap(was[k]))) { out[k] = merge(now[k], rec[k], was[k] || {}, path + '.'); continue; }
      const side = pick ? pick(path) : null;
      if (side === 'mine') take();
      else if (side !== 'theirs') clashes.push(path);
    }
    return out;
  };
  const out = merge(current, record || {}, base || {}, '');
  if (clashes.length) {
    const error = /** @type {CodedError} */ (new Error('This record changed elsewhere (' + clashes.join(', ') + '); both versions are kept'));
    error.code = 'write-conflict'; error.remote = current || null; error.fields = clashes; throw error;
  }
  return out;
}

// The fields of a held save that clash with the server's copy (mergeHeld's paths; [] when none do).
/**
 * @param {Doc | null} current
 * @param {Doc | null} record
 * @param {Doc | null} base
 * @param {MergeOptions} [options]
 * @returns {string[]}
 */
export function clashingFields(current, record, base, options = {}) {
  try { mergeHeld(current, record, base, { ...options, pick: null }); return []; }
  catch (e) { const error = /** @type {CodedError} */ (e); if (error.code === 'write-conflict') return error.fields; throw error; }
}

// A time as people read it, in a time zone (default Singapore): 'Sun 25 Oct, 14:05'. '' for no time.
/** @param {number | string} ms @param {string} [timeZone] @returns {string} */
export function whenText(ms, timeZone = 'Asia/Singapore') {
  const t = typeof ms === 'string' ? Date.parse(ms) : Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

/** @param {any} record @param {string} path */
const valueAt = (record, path) => path.split('.').reduce((v, k) => isMap(v) ? v[k] : undefined, record);

// What a conflict popup shows for a held save, side by side (pure; framework-free, the app renders it):
// held: { record (this device's version), base (what it started from), remote (the server's now; null: deleted
// there), at (when this device saved it, ms) }. options: counters, skip (as mergeHeld), edits (the field holding who
// changed each field and when, the adapter's `edits` option), me: { by, device } (this device's signed-in name and
// device name), timeZone. -> { deleted: { mine, theirs }, fields: [{ path, mine, theirs }], mine, theirs }: each side
// is { value (whole record at the top), at (ms), when (text), by, device }; fields lists only the clashing ones (none
// when either side deleted the record: then the choice is the whole record).
/**
 * @param {HeldSave} held
 * @param {MergeOptions & { edits?: string | null, me?: { by?: string, device?: string }, timeZone?: string }} [options]
 * @returns {ConflictView}
 */
export function describeConflict({ record, base = null, remote = null, at = 0 }, { counters = [], skip = [], edits = null, me = {}, timeZone } = {}) {
  const mineDeleted = !!record?._deleted, theirsDeleted = !remote;
  /** @param {any} v */
  const msOf = v => typeof v === 'string' ? Date.parse(v) || 0 : Number(v) || 0;
  const changes = Object.values(edits && isMap(remote?.[edits]) ? remote[edits] : {}).filter(isMap);
  /** @param {any} value @param {any} when @param {string} [by] @param {string} [device] */
  const side = (value, when, by, device) => ({ value, at: msOf(when), when: whenText(msOf(when), timeZone), by: by || '', device: device || '' });
  /** @param {any} value */
  const mineSide = value => side(value, at, me.by, me.device);
  // theirs: who changed that field there and when (the record's latest change for the whole record); else its stamp
  /** @param {any} value @param {string | null} [top] */
  const theirsSide = (value, top) => {
    const e = top ? remote?.[/** @type {string} */ (edits)]?.[top] : [...changes].sort((a, b) => msOf(b.at) - msOf(a.at))[0];
    return isMap(e) ? side(value, e.at, e.by, e.device) : side(value, remote?.updatedAt);
  };
  const fields = mineDeleted || theirsDeleted ? [] : clashingFields(remote, record, base, { counters, skip: edits ? [...skip, edits] : skip })
    .map(path => ({ path, mine: mineSide(valueAt(record, path)), theirs: theirsSide(valueAt(remote, path), path.split('.')[0]) }));
  return { deleted: { mine: mineDeleted, theirs: theirsDeleted }, fields, mine: mineSide(record), theirs: theirsSide(remote, fields.length === 1 ? fields[0].path.split('.')[0] : null) };
}

// The version to save for a held save once the user has chosen (pure): choice 'mine' | 'theirs', or { [path]: 'mine'
// | 'theirs' } per clashing field (a field not named stays theirs: nothing is overwritten without asking). This
// device's other changes (fields that don't clash) are kept either way; saved over remote (the queue's restore).
// A whole-record choice when either side deleted it: mine is this device's version, theirs the server's (a delete
// when it was deleted there).
/**
 * @param {HeldSave} held
 * @param {ConflictChoice} choice
 * @param {MergeOptions} [options]
 * @returns {Doc}
 */
export function resolvedRecord({ record, base = null, remote = null }, choice, { counters = [], skip = [] } = {}) {
  /** @param {string} path @returns {'mine' | 'theirs'} */
  const pick = path => typeof choice === 'string' ? choice : choice?.[path] === 'mine' ? 'mine' : 'theirs';
  const whole = typeof choice === 'string' ? choice : 'theirs';
  const id = record?.id ?? remote?.id;
  if (record?._deleted || !remote) return clone(whole === 'mine' ? record : remote || { id, _deleted: true });
  return { ...mergeHeld(remote, record, base, { counters, skip, pick }), id };
}
