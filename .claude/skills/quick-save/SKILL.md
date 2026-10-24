---
name: quick-save
description: Cheap end-of-session save for repositories that keep a STATUS.md and NOTES.md. Updates the state files, opens a documentation-only PR and merges it once checks pass, so the session can be archived without losing anything. Use when the owner says "quick save", before archiving a session, or when the context is large and a full save would cost too much.
---

# Quick save

For the end of a session, or a long one that must stop now. Everything needed to carry on goes onto the default
branch, using as few tokens as possible: no browser runs, no screenshots, no re-reading large files.

1. **Which app.** The folder(s) this session worked on (or the repo root).
2. **Update only what changed**, replacing stale lines rather than adding history:
   - `STATUS.md`: Now, Waiting on the owner, Next (in order, enough detail to start without the chat), Recently done
     (merged PR numbers), and dated one-line decisions;
   - `NOTES.md`: only lasting rules, owner preferences and lessons, never task chatter.
3. **Public repository rule.** Nothing private: no personal data, secrets or tokens, and nothing private about the
   owner's setup. Re-read your diff once for these.
4. **Docs-only check.** `git diff --name-only origin/main...HEAD` must list only `.md` files. If anything else
   changed, stop: this is not a quick save; use the normal PR flow.
5. **Commit and push** your session branch and open a PR titled `<App>: quick save (<date>)` with the body "Docs only".
6. **Merge** it (squash) once the repo's required checks pass and the PR is clean. If checks are red or the PR is
   not clean, leave it open and say why. Never merge a PR that changes more than the docs above.
7. **Unsubscribe from your PR** (`unsubscribe_pr_activity`) once it is merged or left open, so the session stops
   waking on PR events.
8. **Tell the owner in at most three lines:** the PR link, merged or not, anything half-done, and that it is safe to
   archive this session. A new session reads STATUS.md and NOTES.md first.
