# Status

## Now
- 1.3.13 (27 Oct): a full read arriving after a record's tombstone (bin heard first) no longer brings the deleted version back to the list and device copy; a newer restore still shows. No API or format change.
- 1.3.12 (27 Oct): speed-ups for big lists (`tools/bench.mjs`: 200 saves on a list of 10k about 18 s -> 8 s), a custom stamp field no longer turns a resend into a conflict, report codes past 20 counted once; no API or format change. Open: a stopped app keeps its watchdog interval and wake listeners (no teardown; not a data risk).
- 1.3.7 (26 Oct): a save done just before going offline keeps showing (`watchSaved`); no API or format change.
- 1.2.0 (26 Oct): `kinds[kind] = { coll, path }`, `backend.unstampedColls`, `watch(..., { listen })`, `facts().inStepAt`, `sync({ reopen })`; additive, no format change.
- 1.1.0 (26 Oct): `sync.saveMany`, `watch(..., { query, limit })`, `backend.merge["*"]` + `replaceRecord`, `backend.commitRetry`; additive, no format change.
- 0.9.2 (25 Oct): the freeze: entries + import-map names `@core/*` (reserved UI-kit names), strict JSDoc + generated `types/`, package `exports`, modularity check, Vite check (external / source / git-installed), FORMATS.md scope rule pinned by hash, SHAPES.md (1.x additions); no runtime change.
- 0.7.0 (25 Oct): JSDoc types across `src/` and `index.js`, `tsc --checkJs` (`npm run typecheck`) as a Checks step; no runtime change.
- 0.6.4 (25 Oct): `firestoreCache` helper (multi-tab cache, steps down to single-tab then memory on quota or "Unexpected state", remembered per device, report codes) and README on what the watchdog covers.

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
- 2026-10-25: 0.6.3 held conflicts by field, opt-in (`backend: { held, edits }`): different fields merge, same value asks nothing, counters add up, a same-field clash is held on the phone that sent it second with a side-by-side popup (`conflicts`, `describe`, `resolve`); report counts held saves by kind (Worker too).
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
- 2026-10-25: held conflicts are opt-in per app (`backend.held`), switched on at each app's bump; a held save lives only on the phone that sent it second, so only that phone answers (no shared marker on the server).
- 2026-10-25: 0.4.0 keeps every 0.3.0 call working; the stamp rule (`max(now, prev + 1)`) is a fix, so it applies by default (an app's own `stamp` function is untouched).
- 2026-10-24: server stamps are a new field (`serverAt`) beside `updatedAt`, opt-in; writers switch first, readers after the backfill and the rules.
- 2026-10-24: the update module lives in this repo under `update/` with its own tags (`update-vX.Y.Z`), lock and path; sync code and its tags are untouched.
- 2026-10-24: 0.2.0 adds options only (no 0.1.0 behaviour changes); merge collections never raise conflicts, and a record deleted elsewhere fails rather than coming back.
- 2026-10-24: each tag is served at `core.anawj.com/sync/<x.y.z>/`; a lock file of file hashes makes a changed release fail the build.
- 2026-10-24: own repo, public, no private pair; versions are immutable and apps pin one.
- 2026-10-24: client timestamps kept in 0.1.0 for compatibility; a server-timestamp mode comes later as opt-in.
- 2026-10-24: Apache License 2.0.
