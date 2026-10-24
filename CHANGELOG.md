# Changelog

## 0.4.1 (2026-10-25)

Fault-injection tests (`test/faults.test.mjs`): the network dropping and coming back mid-queue, two devices writing one
record (clocks apart, lost transaction races), sign-out with saves not sent, data left by 0.3.0 clients, Firestore's
transient errors, a record leaving the query with unsent saves, and the update module's reload with a draft open.

- Fixed: a record with unsent saves whose bin or leave-feed entry arrives (deleted, locked or moved elsewhere) stays
  on this device and `onLeave` reports it, as 0.4.0 already did when the query dropped it; it was removed, so the
  save's conflict had no record to show against. Also for a collection nobody watches at that moment.
- Docs: after `forgetDevice` says no (`proceed` false), the hub is stopped; the app watches again.

## 0.4.0 (2026-10-25)

Safety pack. Nothing changes for 0.3.0 callers that leave the new options out, except the fixes marked below. Each
change has a test in `test/safety.test.mjs` that failed before it (the adapter's also in `test/firestore.emulator.mjs`).

- Fixed: the adapter's default stamp is `max(now, the server copy's stamp + 1)`, taken inside the commit transaction
  (plain and merge commits, numbers and ISO strings), so a writer whose clock is behind the last writer's still moves
  the stamp forward and delta readers see the change. An adapter given its own `stamp` function is unchanged.
  `stamp(prev)` and `stampFields(prev)` give the same rule for an app's own writes (no argument: now, as before).
- Fixed: `leaveEntry(kind, record, at)` stamps `deletedAt` as `max(at, record.updatedAt + 1)`, in the type of `at`,
  so an entry is always after the version it removes (0.3.0 gave `at` as it was, also when equal).
- Fixed: the write queue treats Firestore `aborted` (another device's transaction on the same record won) as
  transient: the save stays pending and is retried, instead of failing and needing the user.
- Adapter `onCommit({ scope, coll, before, after, at, fields })`: more writes (`{ path, data, merge }` or
  `{ path, delete: true }`) in the same transaction as a record's write, e.g. a leave entry with a lock.
- Adapter `clearCache()`: terminates the SDK and clears its offline cache (sign-out on a shared device).
- `syncStatus({ confirmed })`: false gives the new state `unknown` instead of `synced` until the server has
  answered once; `atRiskOnlyOffline: true` says `at-risk` only while offline.
- Write queue `otherPending: async () => bool`: writes sent outside the queue keep the sign-out check (`flush`) shut
  (a throw too); `queue.unsent(kind, id)` says a record has saves not sent yet.
- Hub and collection `unsent` and `onLeave`: a record that leaves the query (delta removal, a full read without it,
  or a check that finds it gone) while it has unsent saves stays on this device and is reported, instead of dropped.
- `forgetDevice({ hub, stores, queue, proceed, keep, clearBackendCache, extra })` (`src/forget.js`): sign-out in one
  order: stop all, check `proceed` again, wipe the stores keeping `keep`, forget the outbox, clear the SDK cache,
  then the app's own; `{ wiped, failed }`.

## update 0.2.0 (2026-10-25)

The update module (`core.anawj.com/update/0.2.0/`), tag `update-v0.2.0`. Nothing changes for 0.1.0 callers that leave
the new options out, except the stamp tool fixes. Tests in `update/test/` (unit and real browser).

- `register({ canReload, beforeReload })`: the take-over reload waits while `canReload()` says no (someone typing,
  a sheet open, changes sending) and is tried again when the tab is hidden or shown, on `pagehide`, and on
  `retryUpdate()`; `beforeReload` runs just before the reload. A worker started with `waitForGo` gets its go
  (`update:go`) only when `canReload` allows. Updates are also checked when the browser comes back online.
- `forceLatest({ canReload })` refuses while `canReload` (given here, else to `register`) says no.
- sw-core `waitForGo: true`: no `skipWaiting` on install; the new version waits for a page's go.
- Fixed (`tools/stamp-versions.mjs`, copied by apps): only exact-version `core.anawj.com/<name>/<x.y.z>/` addresses
  count as pinned; any other cross-site `SHELL` entry gets a new hash every deploy, so a changed file under a moving
  address (`…/v1/`) reaches the phones. The date is the app folder's last git change in SGT (was today in UTC).

## 0.3.0 (2026-10-24)

Server stamps, as an option. Nothing changes for 0.2.0 callers that leave the new options out, except the fix below.
Each addition has a test in `test/server.test.mjs` (the adapter's in `test/firestore.emulator.mjs`).

- `stampMode: 'server'` (adapter, hub, collection, bin feed): every commit also sets `serverAt` (`serverField`) to
  the server's time, in the same transaction, beside the usual stamp; the delta read is `serverAt >` the newest
  server stamp this device has had confirmed (`planServer`, `meta.anchor`), with no SKEW and no local clock. So a
  write that reached the server late, a writer clock behind or a reader clock ahead no longer hides a change until
  the weekly full read. A stamp not yet resolved (this device's pending write) or a cached snapshot never moves the
  anchor; a held record without a server stamp makes opens read in full until a backfill stamps it. Reads give
  `serverAt` as ms; the conflict check leaves it out. `stampFields()` gives the stamps for an app's own writes.
- `feeds: { [coll]: kinds }` (hub): more tombstone feeds shaped like the bin, for records that leave a query without
  being deleted (locked, moved, access removed); `leaveEntry(kind, record, at)` builds the entry to write.
- Fixed: `replanOnWake` also checks hourly (`every`, `REPLAN_EVERY`) while the page is shown, so a page that stays
  visible for days still starts its weekly full read.

## 0.2.0 (2026-10-24)

For apps adopting the engine from whole-collection listeners and last-write-wins saves. Nothing changes for 0.1.0
callers that leave the new options out. Each addition has a test in `test/adopt.test.mjs` (the adapter's in
`test/firestore.emulator.mjs`).

- Stamps (`updatedAt`, `deletedAt`) may be ISO strings as well as numbers (`timeOf`); the adapter's `time: 'iso'`
  writes and queries them as ISO strings.
- `unstamped: 'full'` (hub or collection): read in full while any record held has no `updatedAt`, until a backfill
  has stamped them all.
- `expire: { [coll]: { field, after } }` (hub): a soft-deleted record leaves the device once its removal time is
  older than `after` (`expireDocs`), since its later deletion for good reaches no delta listener.
- Last-write-wins by field: the adapter's `merge: { [coll]: true | fn }` writes the server's copy with this change
  merged in (`mergeFields`: changed fields win, maps merged key by key), never a conflict; a record deleted elsewhere
  fails as `not-found` instead of coming back. `mark` keeps the last save keys on the record so a save sent twice is
  applied once.
- `queue.save(kind, owner, record, base, { ops })` stores the change's ops and hands them, with the save's key, to
  `backend(owner, kind, record, base, { key, ops })`; a failed save replaced by a newer one passes its ops on.
- The adapter's `where(scope, coll)` filters every query of a collection; `stamp()` gives the stamp for now, for an
  app's writes outside the queue.

## 0.1.0 (2026-10-24)

First release: the sync engine, write queue, device stores, outbox, listener watchdog, status rules, storage guard
and Firestore adapter as brand-neutral ES modules, with the backend injected.

Fixed compared with the code it was taken from (each with a test in `test/fixes.test.mjs`):

- The bin feed now remembers the newest `deletedAt` it has seen and reads from there, so a device whose clock was
  fast at its last sync still receives tombstones stamped since.
- A page left open longer than the full-read interval now reads in full when it wakes (`hub.replan()`,
  `replanOnWake`), instead of keeping one ever-growing delta query.
- The sign-out check (`queue.flush()`) now fails closed when the shared outbox cannot be read.
- A backend call that never settles now times out (`sendTimeout`, 30 s) and is retried, instead of holding that
  record's saves until reload.
- Tombstones written to a collection's store while its engine is starting are no longer lost from its meta.

New: `createWatchdog` (with `decide`), `syncStatus` (`attention`, `at-risk`, `offline`, `saving`, `stale`,
`synced`), `persistGuard`, configurable store prefix, realm, bin collection and kinds.

Known limits: timestamps come from the writers' clocks. A writer more than 10 minutes behind, or a reader whose clock
stays more than 10 minutes ahead, can miss a change until the weekly full read; a record deleted without a bin entry
stays on a closed device until then. A server-timestamp mode is planned.
