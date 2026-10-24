# Notes

Lasting rules, owner preferences and lessons (never task chatter), and how to test.

## How to test

- Unit: `node --test test/*.test.mjs` (fake server in `test/fake-server.mjs`, memory stores in Node).
- Emulator: `npm ci && npm run test:emulator` (demo project `demo-app-sync`, open test-only rules in
  `test/emulator.rules`; Java 11+).

## Lessons

- A delta listener only hears changes inside its result set: a hard delete of an older record needs a tombstone or
  a full read.
- A Firestore listener can go quiet without an error; the watchdog's signs are fromCache too long, a pending flag
  that never clears, or nothing heard at a wake moment.
- Hosting: `tools/build-sync.mjs` builds `dist/sync/<x.y.z>/` (index.js, src/, LICENSE, NOTICE) from each `vX.Y.Z` tag
  and checks it against `versions.lock.json`; the Worker (`worker/`) serves only those files at
  `core.anawj.com/sync/<x.y.z>/` (one-year immutable cache, CORS `*`: public code, no credentials) and
  `/sync/versions.json` (5 min). A moved tag or edited released file fails the build, so a re-deploy cannot change a version.
