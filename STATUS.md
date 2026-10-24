# Status

## Now
- Update module `update/` (service worker core + page module for the apps' instant updates), 0.1.0: `core.anawj.com/update/0.1.0/sw-core.js` and `register.js` once tagged `update-v0.1.0`.
- Live: `https://core.anawj.com/sync/0.1.0/` (Worker `app-sync`, deployed 2026-10-24 17:24 SGT); `/sync/versions.json` lists versions.
- 0.2.0 (adoption options: ISO stamps, unstamped full reads, soft-delete expiry, merge commits with ops, query filters).
- 0.1.0 released: engine, write queue, stores, outbox, watchdog, status rules, storage guard, Firestore adapter.

## Waiting on the owner
- Nothing.

## Next (in order)
1. Server-timestamp mode (a field set by the server, enforced by rules) for new apps.
2. A multi-device soak test (offline devices, same-record edits, skewed clocks) in real browsers.

## Recently done
- 2026-10-24: update module 0.1.0 (all-or-nothing install, changed-files-only updates, instant take-over, runtime caps, offline page), with unit and real-browser tests.
- 2026-10-24: 0.2.0 for apps adopting from whole-collection listeners (see CHANGELOG).
- 2026-10-24: repo created; 0.1.0 extracted with five fixes (see CHANGELOG).

## Decisions (dated, one line each)
- 2026-10-24: the update module lives in this repo under `update/` with its own tags (`update-vX.Y.Z`), lock and path; sync code and its tags are untouched.
- 2026-10-24: 0.2.0 adds options only (no 0.1.0 behaviour changes); merge collections never raise conflicts, and a record deleted elsewhere fails rather than coming back.
- 2026-10-24: each tag is served at `core.anawj.com/sync/<x.y.z>/`; a lock file of file hashes makes a changed release fail the build.
- 2026-10-24: own repo, public, no private pair; versions are immutable and apps pin one.
- 2026-10-24: client timestamps kept in 0.1.0 for compatibility; a server-timestamp mode comes later as opt-in.
- 2026-10-24: Apache License 2.0.
