# app-update (frozen here at 1.5.5)

app-update moved to **app-ui** on 6 Nov 2026: new versions are served at
`https://core.anawj.com/ui/<x.y.z>/update/sw-core.js` and `register.js`, with app-ui's version (docs: app-ui's
`docs/app-update.md`; stamp tool: app-ui's `tools/stamp-versions.mjs`). The code there is the same as 1.5.5 here,
apart from `CORE_VERSION`, plus an opt-in share option.

Every address released from this repo stays served unchanged, for good: `https://core.anawj.com/update/<x.y.z>/` for
0.1.0, 0.2.0 and 1.0.0-rc.1 to 1.5.5 (all the same code as 0.2.0 apart from `CORE_VERSION`). Later engine tags carry no
update core. The two files here are the frozen 1.5.5 copy, still exported by the npm package (`./update/register`,
`./update/sw-core`) for builds that import them; deprecated, gone in 2.0. Never edit them: `node tools/build-update.mjs
--check` fails. The full old README is in git history (before 6 Nov 2026).

Moving an app: replace `https://core.anawj.com/update/<v>/` with `https://core.anawj.com/ui/<app-ui version>/update/`
in `sw.js` (SHELL and `importScripts`) and the page's import, and take app-ui's `tools/stamp-versions.mjs`.
