// Concurrency checks for the write queue (writes.js) and a backend's commit.

// Pure equality: key order and updatedAt are ignored (a backend refreshes updatedAt on save), so identical content
// sent again after a lost acknowledgement is idempotent.
export function recordSignature(record) {
  const sort = value => Array.isArray(value) ? value.map(sort) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter(k => k !== 'updatedAt').map(k => [k, sort(value[k])])) : value;
  return JSON.stringify(sort(record || null));
}

// current: the server's copy now; desired: what this device sends (null: a delete); base: the copy the edit started
// from. -> false: nothing to write (already there); true: write it. Throws { code: 'write-conflict', remote } when
// the record changed elsewhere since base: both versions are kept, nothing is overwritten.
export function checkWrite(current, desired, base, message = 'This record changed elsewhere; both versions are kept') {
  if (recordSignature(current) === recordSignature(desired)) return false;
  if (recordSignature(current) !== recordSignature(base)) {
    const error = new Error(message);
    error.code = 'write-conflict'; error.remote = current || null; throw error;
  }
  return true;
}

// Last-write-wins by field, for collections that need no conflict screen: what this device changed since base wins,
// everything else keeps what the server holds now (current). Plain objects are merged key by key, so two devices
// changing different keys of one map both keep their change; arrays and other values are replaced whole. A key the
// record no longer has (but base had) is removed. Without a base (not known here yet), every field sent is merged into
// current. updatedAt is the backend's (ignored here). -> the merged record (current is not changed)
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
export function mergeFields(current, record, base) {
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
