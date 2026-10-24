# Changelog

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
