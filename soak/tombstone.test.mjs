// Focused fake-listener reproduction: a second drop must not hide a newer restore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionSync } from '../src/sync.js';
import { createStores } from '../src/store.js';

for (const first of ['local drop', 'bin tombstone']) test(`${first} followed by local drop preserves the boundary for a later restore`, async () => {
  const { openStore } = createStores({ prefix: 'soak-repeat-drop:', colls: ['items'] });
  const store = await openStore('fake-scope');
  let snap;
  let shown = [];
  const sync = createCollectionSync({ scope: 'fake-scope', coll: 'items', store, now: () => 1_000_000,
    listen: (_scope, _coll, _opts, cb) => {
      snap = cb;
      cb({ full: true, docs: [{ id: 'fake-item', updatedAt: 100, text: 'made up' }], changes: [], fromCache: false });
      return () => {};
    } });
  const off = sync.subscribe(list => { shown = list; });
  try {
    await sync.ready;
    await sync.flush();
    if (first === 'local drop') await sync.drop(['fake-item']);
    else await sync.tombs([{ id: 'fake-item', deletedAt: 100 }]);
    assert.equal(sync.tomb('fake-item'), 100);
    await sync.drop(['fake-item']);
    snap({ changes: [{ type: 'added', id: 'fake-item', doc: { id: 'fake-item', updatedAt: 101, text: 'restored' } }], fromCache: false });
    await sync.flush();
    assert.deepEqual(shown.map(d => d.id), ['fake-item'], 'a restore stamped after the deleted version must show after repeated drop');
  } finally {
    off();
    await sync.stop();
  }
});
