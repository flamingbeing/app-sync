# app-sync

An offline-first sync engine for web apps, as plain ES modules with no dependencies. The backend is injected; a
Firestore adapter is included. Each tagged version is served unchanged at `https://core.anawj.com/sync/<x.y.z>/`, and an app pins an
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
  when nothing is waiting, failed or in conflict and the server is being heard (with `confirmed`, `unknown` until the
  server has answered once).
- **Stamps only move forward.** The adapter stamps `max(now, the server copy + 1)` inside the commit transaction, so
  a writer whose clock is behind still moves a record's stamp on (0.4.0).
- **Sign-out wipes the device.** The sign-out check refuses while anything is unsent (in any tab, and the app's own
  writes through `otherPending`), then `forgetDevice` stops everything, checks again, and deletes every store but the
  account kept, the outbox, the SDK's offline cache (`clearCache`) and the app's own lists, in every tab.

## Modules

| Module | Exports |
|---|---|
| `src/sync.js` | `createSyncHub`, `createCollectionSync`, `createTombFeed`, `replanOnWake`, `leaveEntry`, pure helpers (`plan`, `planServer`, `applyChanges`, `applyTombs`, `binTombs`, …) |
| `src/writes.js` | `createWriteQueue` |
| `src/conflict.js` | `checkWrite`, `recordSignature`, `mergeFields`; held conflicts (0.6.3): `mergeHeld`, `clashingFields`, `describeConflict`, `resolvedRecord`, `whenText`; for merge collections (0.7.1): `mergeClashes`, `mergeFnClashes` |
| `src/store.js` | `createStores` (the device copy: `openStore`, `wipeStores`) |
| `src/outbox.js` | `createOutbox` (the write queue's durable store) |
| `src/watchdog.js` | `decide`, `createWatchdog` |
| `src/cache.js` | `firestoreCache` (multi-tab offline cache, steps down on quota or "Unexpected state") |
| `src/status.js` | `syncStatus`, `attentionCount` |
| `src/persist.js` | `persistGuard` (asks the browser to keep the site's storage) |
| `src/firestore.js` | `createFirestoreBackend` |
| `src/report.js` | `createReport`, `buildReport` (the nothing-lost report, opt-in) |
| `src/app.js` | `createApp` (all of the above wired in one call), `userOf`, `claimsBehind` |
| `index.js` | all of the above |

## Use

```js
import { createApp } from 'https://core.anawj.com/sync/0.6.3/index.js';

const app = createApp({
  name: 'myapp', colls: ['items'], path: (space, coll) => ['spaces', space, coll],
  sdk: async () => ({ A, F, auth, db }),          // the app's Firebase SDK, initialised (Auth and Firestore functions)
  scope: user => user.email,                     // what to open at sign-in (or call app.open(space) later)
  claims: { url: '/api/claims', entry: user => roleDoc(user) },   // optional: role claims on the token
  onRefused: (err, entry) => 'archive',          // optional: a save the server refused (else it waits for the user)
  forget: { extra: async () => clearAppLists() },               // optional: the app's own lists, wiped at sign-out
});

await app.signIn();
app.status$(st => drawChip(st));                 // { state, count }: synced only once the server has answered
const off = app.watch(space, 'items', list => render(list));    // device copy, then the server; unsent saves laid over
await app.save('items', space, { id: 'i1', text: 'Hello' }, previousCopy);   // base: the copy the edit started from

const out = await app.signOut();                 // { ok, reason: 'unsent' | 'changed', reload }
if (out.ok && out.reload) location.reload();     // the SDK's offline cache was cleared
```

Anything the facade does not cover: pass the parts' own options (`backend`, `hub`, `stores`, `queue`), replace a part
(`adapter`, `commit`, `outbox`), or use `app.parts` (hub, queue, stores, adapter, watchdog, registry). Each module
also loads on its own; the full wiring by hand (0.5.x style) still works, and `src/app.js` shows it in one place.
Each module's header comment describes its options and contract in full.

### Held conflicts by field (0.6.3, opt-in)

```js
const app = createApp({ …, device: 'Ward phone',
  backend: { held: true, edits: '_edits', mark: '_saves' } });   // or held: { items: { counters: ['qty'] } }
app.status$(st => drawChip(st));                 // 'attention' while a held save is unanswered
for (const c of app.conflicts()) {               // this phone's held saves only
  const d = app.describe(c.key);                 // d.fields: [{ path, keys, mine, theirs }], each { value, when (SGT), by, device }
  await app.resolve(c.key, await askUser(d));    // 'mine' | 'theirs' | { [path]: 'mine' | 'theirs' }
}
```

Two phones changing different fields of a record both keep their change; the same field changed to the same value
asks nothing; counters add up. Only a field changed on both sides to different values holds the save, on the phone
that sent it second and nowhere else (the server never has it, so no other phone has anything to answer), until the
user chooses; nothing is overwritten without that answer, and this phone's other changes land either way. `edits`
records who changed each field and when (`{ by, device, at }` per top-level field), a data-shape change: security
rules that whitelist fields must allow that field (and `mark`'s). `createReport({ byKind: true })` counts held saves
per kind in the report, so a kind that clashes often shows in the digest. Off by default: without `held`, every
collection keeps the whole-record check.

A merge collection (`merge: { items: fn }`, the merge function applying the save's ops) is held too when `held`
names it (0.7.1; `held: true` leaves merge collections last-write-wins): the merge function still applies ops such as
increments, which never clash; only a path changed on both sides to different values, where the merge would take this
phone's value over the other's, holds the save. Pass the copy the edit started from as base.

### The offline cache and what the watchdog covers (0.6.4)

```js
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager, memoryLocalCache } from 'firebase/firestore';
const F = { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager, memoryLocalCache };
const { db, mode, failed } = firestoreCache(F, { app: firebaseApp, report });   // mode: 'multi' | 'single' | 'memory'
// from a listener's error callback or a failed SDK call:
if (failed(err).changed) location.reload();      // the next load starts one step lower
```

Tabs share one offline cache (`multi`); if the SDK refuses it, or the storage is full, the device steps down to one
tab (`single`), then to memory only, and stays there (remembered on the device; `reset()` tries again). The step goes
in the report as `cache-quota` / `cache-state` (what failed) and `cache-single` / `cache-memory` (the step in use).
Memory only means nothing offline between loads; unsent saves still wait in the outbox, which is separate. Without
`app`, the helper returns just `cache` for your own `initializeFirestore`. Apps that don't call it keep their cache.

The listener watchdog covers a stream that goes **silent** (shows only the phone's copy for too long, a flag that
never clears, no word from the server after the phone comes back); it listens again, then restarts the connection.
It does **not** cover: an offline phone whose listener never calls back at all
([firebase-js-sdk#8696](https://github.com/firebase/firebase-js-sdk/issues/8696): the status then says `offline`, not
`synced`), nor a full browser storage quota ([#8305](https://github.com/firebase/firebase-js-sdk/issues/8305): use
`firestoreCache`'s step-down). Neither case shows `synced` without the server having been heard (see the status rules).

## What stays in each app

Schemas and the clean/canonical form of a record, collection names and paths, security rules, which collections need
conflict handling, the bin and history screens, and how the status looks.

## Server rules the engine relies on

- Every synced document carries a number field (default `updatedAt`) that only increases when it changes; in server
  mode also `serverAt`, set to `request.time` on every write.
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
