import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteQueue } from '../src/writes.js';
const clone = x => structuredClone(x);
test('a save whose job a rescan read first still ends synced (the sorted copy follows the replacement)', async () => {
  const records = new Map(), remote = new Map();
  let online = false, gate = null;
  const store = {
    async put(x) { records.set(x.key, clone(x)); if (x.record.v === 'A' && !gate?.used) { gate = gate || {}; gate.used = true; await new Promise(r => { gate.release = r; }); } },
    async list(o) { return [...records.values()].filter(x => x.owner === o).map(clone); },
    async get(k) { return records.has(k) ? clone(records.get(k)) : null; },
    async remove(k) { records.delete(k); }, async forget() { records.clear(); },
  };
  const q = createWriteQueue({ store, getOwner: () => 'a', online: () => online, delay: ms => new Promise(r => setTimeout(r, 5)),
    backend: async (_o, _k, record) => { remote.set(record.id, clone(record)); return record; } });
  await q.activate('a');
  const pA = q.save('item', 'a', { id: '1', v: 'A' });           // A's store.put lands but its promise is slow
  while (!gate?.release) await new Promise(r => setTimeout(r, 1));
  await q.save('item', 'a', { id: '1', v: 'B' }, { id: '1', v: 'A' });   // B finishes first, clears the in-flight mark
  await q.kick();                                                   // online/visibility: rescan reads A from the store
  gate.release();
  await pA;
  online = true;
  const sent = await q.flush(500);
  assert.equal(remote.get('1').v, 'B');
  assert.equal(q.pending(), 0, 'pending() should be 0 once both saves are on the server');
  assert.equal(sent, true, 'flush (the sign-out gate) should open');
});
