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
| `src/conflict.js` | `checkWrite`, `recordSignature` |
| `src/store.js` | `createStores` (the device copy: `openStore`, `wipeStores`) |
| `src/outbox.js` | `createOutbox` (the write queue's durable store) |
| `src/watchdog.js` | `decide`, `createWatchdog` |
| `src/status.js` | `syncStatus`, `attentionCount` |
| `src/persist.js` | `persistGuard` (asks the browser to keep the site's storage) |
| `src/firestore.js` | `createFirestoreBackend` |
| `src/report.js` | `createReport`, `buildReport` (the nothing-lost report, opt-in) |
| `index.js` | all of the above |

## Use

```js
import * as F from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
import { createSyncHub, createWriteQueue, createStores, createOutbox, createFirestoreBackend, replanOnWake,
  persistGuard, syncStatus, attentionCount, forgetDevice } from 'https://core.anawj.com/sync/0.4.2/index.js';

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
const status = syncStatus({ online: navigator.onLine, pending: queue.pending(), attention: attentionCount(queue.entries()), persisted,
  confirmed: heard, atRiskOnlyOffline: true });   // heard: a snapshot with fromCache false since the page opened

// sign-out, after `await queue.flush()` said nothing is unsent (proceed false: nothing deleted, but the hub is
// stopped, so watch again)
await forgetDevice({ hub, stores, queue, proceed: async () => stillSigningOut(), keep: () => otherTabAccount(),
  clearBackendCache: fs.clearCache, extra: async () => clearAppLists() });
location.reload();   // the SDK was terminated by clearCache
```

Each module's header comment describes its options and contract in full.

## Adopting

Three shapes of app, and what each passes in. Pin the version, precache it, and keep the app's own tests running
against the emulator before switching users over.

**Records with a conflict screen and a recycle bin.** The default: `merge` left out, so each save is checked against
the copy it started from and a change made elsewhere is kept as a conflict for the user to choose. Deletes go through
the queue (`{ id, _deleted: true }`) and the bin entry (`{ id, kind, data, deletedAt }`) is written beside it; the hub's
`binKinds` maps entry kinds to collections. Writes that used to bypass an outbox (batches, indexes, settings) go
through the queue too, so the status counts them.

**Shared records merged by field (no conflict screen).** Name the collections in the adapter's `merge`. With `true`,
`mergeFields` applies the fields this device changed onto the server's copy. When a change is an increment or a
keyed update, pass it as ops (`queue.save(…, { ops })`) and give `merge` a function that applies ops to the
server's copy; set `mark` (a field the security rules allow) so a resend counts once. A soft delete (a `removedAt`
style field) stays an ordinary save; `expire` drops such a record from devices once it is due to be deleted for good.
If the app already stamps ISO strings, keep them: `time: 'iso'`.

**Records scoped by a query (one site, unlocked only).** Pass `where(scope, coll)`; a delta query then needs a
composite index on those fields plus the stamp field. A record that leaves the query (locked, moved) leaves the
device. Per-field timestamps inside a record can stay: give `merge` the app's own merge function.

**Moving existing data.** Records written before adoption may have no `updatedAt`. Run the hub with
`unstamped: 'full'` until a one-off job has stamped every record (count before and after; a dry run first), then
drop the option so opens read only changes. Make the rules require the stamp on every write, so an app version still
on someone's phone cannot write an unstamped change that delta readers would miss.

**Moving off the SDK's own queue.** Send every save through the write queue (the adapter commits in a transaction,
which never waits in the SDK's offline queue), so nothing is left that only the SDK's cache holds; call
`persistGuard()` at sign-in, run `createWatchdog` on the listeners, and
make sign-out use `queue.flush()` (it refuses while anything is unsent) before wiping stores.

**Server stamps (0.3.0).** With writers' clocks, a change can hide until the weekly full read: a writer clock more
than 10 minutes behind, or a reader clock that stays that far ahead. `stampMode: 'server'` removes the clocks from
the delta read: the adapter sets `serverAt` with `serverTimestamp()` in every commit (beside `updatedAt`, which
stays), and the hub reads `serverAt >` the newest server stamp it has had confirmed. Roll it out in this order, so no
change is missed while app versions are mixed:

1. Writers: give the adapter `stampMode: 'server'` (the hub keeps the default). Stamp the app's own writes outside
   the queue (bin entries, leave entries) with `await fs.stampFields()`.
2. Backfill `serverAt` on every record and bin entry that has none (count before and after; a dry run first).
3. Once no older app version can write (an update module makes one reload enough), require the stamp in the rules
   (`request.resource.data.serverAt == request.time` on every create and update), then give the hub
   `stampMode: 'server'` too. Until the backfill is done, a record held without `serverAt` makes opens read in full.

A query filtered with `where` then needs a composite index on its fields plus `serverAt`.

**Records that leave a query.** A record locked or moved out of a filtered query is never heard of again by a delta
listener, so a device that was closed keeps it until the weekly full read. Write a leave entry
(`leaveEntry(kind, record)` plus the stamps) to a feed collection when it leaves, and name that collection in the
hub's `feeds` (and in the stores' `metaOnly`): devices drop that version at their next open, and a newer version (the
record unlocked) shows again.

**Leave entries in the same transaction (0.4.0).** Give the adapter `onCommit` and return the leave entry from it
when a commit locks or moves a record: it is written in the record's own transaction, so no device sees the lock
without the entry (or the other way round), and its `deletedAt` is after the locked version (`leaveEntry` stamps
`max(at, updatedAt + 1)`). A record that leaves while this device still has unsent saves for it (the query drops it, or
its bin or leave entry arrives) is kept here, and the
hub's `onLeave(scope, coll, id, doc)` says so (pass `unsent: (scope, coll, id) => queue.unsent(kind, id)`), so the
save meets the server's answer instead of vanishing with the record.

**Several apps on one origin (0.4.2).** Apps served from one address share Firebase sign-in, so signing out in one
signs out all of them, and each may have its own outbox with saves not sent yet. Register every app's outbox in the
origin's registry and give each queue the registry: `queue.flush()` then also refuses while any registered outbox
has unsent saves for this user (one that can't be read or doesn't answer in 3 s counts as unsent), and
`forgetDevice` (through `queue.forget()`) forgets this user in all of them. Opt-in: an app that doesn't register, or
a queue without `registry`, works as before, so roll it out to every app on the origin before relying on it.

```js
const outbox = createOutbox({ name: 'app-outbox' });
const registry = createOutboxRegistry();   // the list lives in localStorage, read by every page of the origin
registry.register(outbox);
const queue = createWriteQueue({ store: outbox, backend, getOwner, registry });
```

`clearCache` waits while another tab of the origin still uses the SDK's cache; it now gives up after 3 s
(`{ timeout }`, and `forgetDevice`'s `timeout` for `clearBackendCache`), reports `clearBackendCache` in `failed`,
and `extra` and the reload still happen. The cache then stays until those tabs close.

**Rules with field whitelists (0.4.2).** If the rules list the fields a document may hold and `id` is not one,
give the adapter `writeId: false`: the id stays the document's id and reads add it back. `onCommit` also gets the
save's `key` and `ops`, so an audit entry can carry the change and use the key as its id (written once).

**A change the server copy no longer allows (0.4.2).** In a flow where someone else can move a record on (cancel,
reassign) while this device saves offline, let the merge function refuse: throw `{ code: 'write-conflict', remote:
current }` (an Error with those fields). The save ends as a conflict with the server's copy kept, and the app offers
discard or try again. Refused by the rules instead (`permission-denied`), it would end as failed and keep sign-out
shut until the user deals with it.

**Two phones at once.** A Firestore transaction that lost a race with another device's (`aborted`) is retried like a
dropped connection, never shown as needing the user.

**Nothing-lost report (0.5.0, opt-in).** So that a save stuck on a phone is noticed without anyone looking:

```js
const report = S.createReport({ app: 'my-app', version: SW_VERSION, storage: localStorage });
const queue = S.createWriteQueue({ ...options, report });
report.start();   // a check every few minutes (sends at most once an hour) and on page hide
```

A report holds counts (saves waiting over an hour, refused, in conflict), sync errors by code and the versions;
never a record, an id, a path, an email or an error message. `report.error(code)` counts an error the app sees
itself (a listener's). The endpoint keeps per-app daily counts; nothing per device or per person.

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
