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
