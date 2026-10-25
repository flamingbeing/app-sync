# Status

## Now
- 0.4.1: fault-injection tests (offline flapping, two devices on one record, sign-out mid-queue, 0.3.0 data, transient errors, leaving with unsent saves, reload with a draft open); a bin or feed entry no longer drops a record with unsent saves.
- 0.4.0 and update 0.2.0 (safety pack): stamps forward, commit hook, `aborted` retried, honest status, unsent records kept on leave, `forgetDevice` + `clearCache`; update reload waits for `canReload`, `waitForGo`, online check, stamp tool pinned rule and SGT date.
- 0.3.0: server stamps (`stampMode: 'server'`), extra tombstone feeds (`feeds`, `leaveEntry`), hourly re-plan in `replanOnWake`.
- Update module `update/` (service worker core + page module for the apps' instant updates), 0.1.0: `core.anawj.com/update/0.1.0/sw-core.js` and `register.js` once tagged `update-v0.1.0`.
- Live: `https://core.anawj.com/sync/0.1.0/` (Worker `app-sync`, deployed 2026-10-24 17:24 SGT); `/sync/versions.json` lists versions.
- 0.2.0 (adoption options: ISO stamps, unstamped full reads, soft-delete expiry, merge commits with ops, query filters).
- 0.1.0 released: engine, write queue, stores, outbox, watchdog, status rules, storage guard, Firestore adapter.

## Waiting on the owner
- Nothing.

## Next (in order)
1. A multi-device soak test (offline devices, same-record edits, skewed clocks) in real browsers.

## Recently done
- 2026-10-25: 0.6.1 model-based multi-device tests (`test/model.test.mjs`, seeded) and the fix they found: a record deleted on this device left its list only at the weekly full read.
- 2026-10-25: 0.6.0 `createApp` (the safe path in one call), with the unreleased 0.5.2 fixes folded in: `watchSaved` (the server's copy heard while a save was sent shows once it is done) and one report per page hide (see CHANGELOG).
- 2026-10-25: 0.5.1 adapter `create` (no read in the transaction) and `existing` (ids the server has), for apmes evals and the logbook restore.
- 2026-10-25: 0.4.1 fault-injection tests and the tombstone fix (see CHANGELOG).
- 2026-10-25: 0.4.0 safety pack and update 0.2.0 (see CHANGELOG).
- 2026-10-24: 0.3.0 server-stamp mode, leave feeds and the hourly re-plan (see CHANGELOG).
- 2026-10-24: update module 0.1.0 (all-or-nothing install, changed-files-only updates, instant take-over, runtime caps, offline page), with unit and real-browser tests.
- 2026-10-24: 0.2.0 for apps adopting from whole-collection listeners (see CHANGELOG).
- 2026-10-24: repo created; 0.1.0 extracted with five fixes (see CHANGELOG).

## Decisions (dated, one line each)
- 2026-10-25: 0.4.0 keeps every 0.3.0 call working; the stamp rule (`max(now, prev + 1)`) is a fix, so it applies by default (an app's own `stamp` function is untouched).
- 2026-10-24: server stamps are a new field (`serverAt`) beside `updatedAt`, opt-in; writers switch first, readers after the backfill and the rules.
- 2026-10-24: the update module lives in this repo under `update/` with its own tags (`update-vX.Y.Z`), lock and path; sync code and its tags are untouched.
- 2026-10-24: 0.2.0 adds options only (no 0.1.0 behaviour changes); merge collections never raise conflicts, and a record deleted elsewhere fails rather than coming back.
- 2026-10-24: each tag is served at `core.anawj.com/sync/<x.y.z>/`; a lock file of file hashes makes a changed release fail the build.
- 2026-10-24: own repo, public, no private pair; versions are immutable and apps pin one.
- 2026-10-24: client timestamps kept in 0.1.0 for compatibility; a server-timestamp mode comes later as opt-in.
- 2026-10-24: Apache License 2.0.
