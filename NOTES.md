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
- `worker/` and `example/` are the repo template's; they will become the version server.
