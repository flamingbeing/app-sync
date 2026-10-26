# Notes

Lasting rules, owner preferences and lessons (never task chatter), and how to test.

## How to test

- When Node cannot spawn child processes, run each unit file directly from PowerShell with `node --test --test-isolation=none test/<file>.test.mjs`; use a fresh process for each repetition. The fixed 40 ms recovery wait in the backend-timeout test can race a 30 ms in-flight timeout plus a 10 ms retry delay; see [1.3.11 soak](SOAK-ROUND-3.md).

- Unit: `node --test test/*.test.mjs` (fake server in `test/fake-server.mjs`, fake SDK in `test/fake-sdk.mjs`, memory
  stores in Node). The model test (`test/model.test.mjs`) runs 40 seeds; `MODEL_SEEDS=500` before a release that touches
  sync, `MODEL_SEED=<n>` to replay a printed failure.
- Emulator: `npm ci && npm run test:emulator` (demo project `demo-app-sync`, open test-only rules in
  `test/emulator.rules`; Java 11+).

- Update module: `node --test update/test/*.test.mjs` (fake worker world in `update/test/fake-sw.mjs`) and
  `node update/test/e2e.mjs` (fixture app + real Chromium; Playwright is installed with `--no-save` in CI).

## Lessons

- A delta listener only hears changes inside its result set: a hard delete of an older record needs a tombstone or
  a full read.
- A Firestore listener can go quiet without an error; the watchdog's signs are fromCache too long, a pending flag
  that never clears, or nothing heard at a wake moment.
- Firestore `serverTimestamp()` inside a transaction resolves on the server; an app's own offline `setDoc` shows the
  field as null (pending) in local snapshots until it reaches the server, so a pending stamp never anchors a read.
- Hosting: `tools/build-sync.mjs` builds `dist/sync/<x.y.z>/` (index.js, src/, LICENSE, NOTICE) from each `vX.Y.Z` tag
  and checks it against `versions.lock.json`; the Worker (`worker/`) serves only those files at
  `core.anawj.com/sync/<x.y.z>/` (one-year immutable cache, CORS `*`: public code, no credentials) and
  `/sync/versions.json` (5 min). A moved tag or edited released file fails the build, so a re-deploy cannot change a version.
- Update module (`update/`): same hosting idea as sync, with its own lock (`update.lock.json`), tags (`update-vX.Y.Z`; from 1.0.0-rc.1 the sync tag `vX.Y.Z`)
  and path (`core.anawj.com/update/<x.y.z>/`: `sw-core.js`, `register.js`). `register()` must not throw offline: with the
  network gone `serviceWorker.register` rejects, so it falls back to the installed registration. The page module is
  loaded from another site, so apps list its exact-pin address in their `SHELL` (cached as a pinned cross-origin file)
  or the page would not start offline.
