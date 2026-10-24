# app-sync

An offline-first sync engine for web apps, as plain ES modules with no dependencies. The backend is injected; a
Firestore adapter is included. Each tagged version will be served unchanged at its own address, and an app pins an
exact version.

What it does:

- **Cheap opens.** Each collection has a copy on the device (IndexedDB, memory fallback). On open the copy shows at
  once, then the engine listens only for documents changed since the last sync (`updatedAt > lastSync - SKEW`),
  so opening with nothing changed costs about one read per collection. A full read runs the first time and weekly,
  and also when a page left open wakes after that week.
- **Deletes that travel.** Tombstones from a bin collection (or a deletion made on this device) remove a record
  everywhere, unless it changed after the deleted version.
- **Saves that are never lost.** Every save goes to a durable outbox first, then to the server one record at a time,
  in order. A save that fails or meets a change made elsewhere (a conflict) is kept until the user chooses; it never
  expires and never blocks a later save made on the version shown. Several tabs share the outbox safely.
- **An honest status.** A listener watchdog notices a stream that went quiet; the status rules say `synced` only
  when nothing is waiting, failed or in conflict and the server is being heard.
- **Sign-out wipes the device.** The sign-out check refuses while anything is unsent (in any tab), then every store
  is deleted, in every tab.

## Modules

| Module | Exports |
|---|---|
| `src/sync.js` | `createSyncHub`, `createCollectionSync`, `createTombFeed`, `replanOnWake`, pure helpers (`plan`, `applyChanges`, `applyTombs`, `binTombs`, …) |
| `src/writes.js` | `createWriteQueue` |
| `src/conflict.js` | `checkWrite`, `recordSignature` |
| `src/store.js` | `createStores` (the device copy: `openStore`, `wipeStores`) |
| `src/outbox.js` | `createOutbox` (the write queue's durable store) |
| `src/watchdog.js` | `decide`, `createWatchdog` |
| `src/status.js` | `syncStatus`, `attentionCount` |
| `src/persist.js` | `persistGuard` (asks the browser to keep the site's storage) |
| `src/firestore.js` | `createFirestoreBackend` |
| `index.js` | all of the above |

## Use

```js
import * as F from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { createSyncHub, createWriteQueue, createStores, createOutbox, createFirestoreBackend, replanOnWake,
  persistGuard, syncStatus, attentionCount } from './app-sync/index.js';

const fs = createFirestoreBackend({ sdk: async () => ({ db, F }), path: (space, coll) => ['spaces', space, coll] });
const stores = createStores({ prefix: 'myapp-store:', colls: ['items'] });
const hub = createSyncHub({ openStore: stores.openStore, listen: fs.listen, fetchOne: fs.fetchOne, binKinds: { item: 'items' } });
replanOnWake(hub);

const queue = createWriteQueue({
  store: createOutbox({ name: 'myapp-outbox' }),
  getOwner: () => currentSpace,
  backend: (space, kind, record, base) => fs.commit(space, 'items', record, base),
  online: () => navigator.onLine !== false,
});
addEventListener('online', () => queue.kick());

const off = hub.watch(currentSpace, 'items', (list, meta) => render(queue.overlay('item', currentSpace, list), meta));
await queue.save('item', currentSpace, { id: 'i1', text: 'Hello' }, previousCopy);   // base: the copy the edit started from

const { persisted } = await persistGuard();
const status = syncStatus({ online: navigator.onLine, pending: queue.pending(), attention: attentionCount(queue.entries()), persisted });
```

Each module's header comment describes its options and contract in full.

## What stays in each app

Schemas and the clean/canonical form of a record, collection names and paths, security rules, which collections need
conflict handling, the bin and history screens, and how the status looks.

## Server rules the engine relies on

- Every synced document carries a number field (default `updatedAt`) that only increases when it changes.
- A bin entry is `{ id, kind, data, deletedAt }`, where `data` is the deleted version.
- Never `merge` an empty map, and never batch-overwrite records without reading them first.

## Tests

```
npm ci
node --test test/*.test.mjs   # unit tests, no network
npm run test:emulator          # the Firestore adapter on the local emulator (needs Java)
node tools/check.mjs           # repo checks
```

## Versions

Semantic versions, tagged `vX.Y.Z`; see [CHANGELOG.md](CHANGELOG.md). A tag is never moved or overwritten. Apps pin an
exact version and upgrade on purpose after their own tests; a breaking change is a new major version. Every fix
lands with a test that failed before it.

## Licence

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
