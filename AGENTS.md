# app-sync

Instructions for every AI assistant working here (Claude Code reads this through `CLAUDE.md`).

A shared, brand-neutral sync engine for the owner's web apps (ES modules, backend injected, Firestore adapter).
Apps load a pinned version; real people's data depends on it, so treat every change as vital.

## Public here, private elsewhere

Anything merged here is public. Keep only code, docs, general rules and **made-up** sample data. Never commit
secrets, tokens, personal data, real names or patient details. Private notes belong in the owner's private notes
repo; never copy anything from there into this repo, a PR or an issue (neutral pointers like "ask the owner" are fine).

## Rules that bite

- **Nothing app-specific in `src/`**: no app names, collection names, wording or schemas. Apps pass them in.
- **No dependencies at run time.** `src/` imports only its own files; the Firebase SDK is passed in by the app.
- **A released tag never changes.** Fixes go in a new version with a CHANGELOG entry; breaking API = new major.
- **Every bug fix starts with a failing test** (`test/fixes.test.mjs` or the module's test), then the fix.
- Never weaken a data-loss gate (outbox, sign-out check, conflict check) to make a test pass.
- Use Opus for changes to `src/`; run the full unit and emulator tests before merging.

## Checks before merging

```
node tools/check.mjs          # repo checks + Worker tests
node --test test/*.test.mjs   # unit tests
npm run test:emulator         # Firestore adapter on the local emulator (Java)
node tools/proofread.mjs      # page and doc mistakes
```

CI also runs app-starter's browser tests on the candidate engine (the `consumer` job; locally: in an app-starter
checkout, `SYNC_DIR=<this checkout> npm run e2e`). A red consumer job is a break for every app: fix it here first.

## Releasing

1. Bump `version` in `package.json` and `VERSION` in `index.js`; add the CHANGELOG entry.
2. Run `node tools/build-sync.mjs --lock` and commit `versions.lock.json` (checks fail without it).
3. Merge with Checks green: `release.yml` then tags that commit `vX.Y.Z` (only if the tag doesn't exist yet).

## The update module (`update/`)

`update/` holds the service worker core and page module the apps share (README inside). It is released separately:
`update/VERSION`, `update.lock.json` (`node tools/build-update.mjs --lock`), tag `update-vX.Y.Z`, served at
`core.anawj.com/update/<x.y.z>/`. Same rules: a released version never changes, no app-specific names. Tests:
`node --test update/test/*.test.mjs`, and `node update/test/e2e.mjs` (needs Playwright with Chromium).

## Working with the owner

- Instructions mostly come from a phone. Work through a request to the end; ask only when a decision is genuinely
  the owner's. When asked to plan, plan and wait.
- Keep each PR small and finished on its own. Start PR titles with "app-sync: …".
- Merge your own PRs once the checks pass, then report with the PR link and call `unsubscribe_pr_activity`.
- Keep `NOTES.md` (lasting decisions, how to test) and `STATUS.md` (now, next, dated decisions) current.
  Cheap end of session: `quick-save`.
- Plain words, short; explain technical terms briefly the first time.

## Token savers

- `.claude/settings.json` is only read when a session has exactly one repo attached; otherwise the environment's
  shared settings apply.
- `node_modules/` is for the emulator test only; never read it.
