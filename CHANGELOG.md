# Changelog

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
