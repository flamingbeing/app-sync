# public-template

Template for public repositories. Click "Use this template" to start a new repo with these already set up:

- `.claude/settings.json`: allow rules (git, PR tools, tests) so cloud sessions rarely prompt, and deny-reads for
  `__/` and `vendor/` to save tokens. Only read when a session has exactly one repo attached (else the
  environment's shared settings apply).
- `AGENTS.md` / `CLAUDE.md`: shared AI instructions skeleton (fill the placeholders).
- `.claude/skills/quick-save`: cheap end-of-session save.
- `STATUS.md`, `NOTES.md`: state files the skill updates.
- `tools/`: `check.mjs` (repo checks + Worker tests; run before merging), `stamp-versions.mjs` (service-worker
  VERSION per deploy), `proofread.mjs` (page and doc mistakes; `--live` checks the real addresses), `shots.mjs`
  (phone screenshots by hand).
- A Cloudflare Worker that serves the apps: `worker/sites.js`, `worker/routes.js` (which folder each address
  serves), its tests in `worker/test/`, and `wrangler.jsonc` with preview links and workers.dev off.
- `example/`: a tiny app with a service worker; replace it and update `SITES` in `worker/routes.js`.

Templates don't copy repo settings: after creating a repo, run the owner's admin workflow `repo-defaults` (auto-delete
head branches, auto-merge, Actions PRs) instead of ticking them by hand.
