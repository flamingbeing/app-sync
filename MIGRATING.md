# Moving an app to base 1: app-sync 1.4.0 + app-ui 1.0.0

Base 1 is two shared cores, each served at an exact version and loaded through the app's import map, never copied
into the app:

| Core | Repo | Served at | Gives the app |
|---|---|---|---|
| data | app-sync 1.4.0 | `https://core.anawj.com/sync/1.4.0/` | `@core/app`, `@core/auth`, `@core/sync`, `@core/update` |
| UI | app-ui 1.0.0 | `https://core.anawj.com/ui/1.0.0/` | `@core/ui`, `@core/theme`, `@core/settings`, the look and layout style sheets, `theme/early.js`, the `/kit/` gallery |

The worked example is app-starter (#50 for the UI core) and sandbox-app (#26, the same change copied over). Open
them next to this guide: every step below is a hunk in those two PRs. (While 1.4.0 is only a release candidate, read
`1.4.0-rc.1` for `1.4.0` and `app-ui 1.0.0-rc.1` for `1.0.0` everywhere; the tags are final once released and the
files are the same.)

An app already on app-sync 1.0-1.3 does only the 1.4 steps (A, C-E); an app still on 0.x or the one-object
`createApp` does the 1.0 steps ("From 0.x to 1.0", below) first. An app moves to base 1
in **one PR, data and UI together** (the ui-core M and L boxes).

## A. The engine: 1.0 to 1.4.0 (additive; nothing to change unless the app wants the new option)

No stored-format change and no removed name between 1.0.0-rc.1 and 1.4.0: phones keep their device copy and unsent
saves across the move. What 1.1-1.3 added (CHANGELOG has the detail); adopt only what the app needs:

- **1.1:** `sync.saveMany(kind, scope, records)`; `watch(..., { query, limit })` (a view, the listener stays whole);
  `backend.merge['*']`; `backend.commitRetry`.
- **1.2:** `kinds: { [kind]: { coll, path } }`; `backend.unstampedColls`; `watch(..., { listen })`;
  `facts().inStepAt`; `sync({ reopen })`; pre-release paths served (`/sync/1.0.0-rc.1/`).
- **1.3:** sign-in methods (`auth({ methods: [emailLink(), ...] })`, default `['google']`) and public read
  (`sync({ public: [coll] })`; each must be in `colls`).
- **1.3.x fixes that change what a user sees, not the API:** one unsent count for the status and the sign-out check;
  a sign-out during a switch wins; a deleted record no longer comes back after a late full read; a save resent after
  a lost answer is no longer a conflict with itself (Firestore adapter compares without its stamp field); faster with
  big lists. An app test that asserted the old behaviour (e.g. a sign-out check counting saves twice) will need its
  expected number changed.
- **1.5 (optional, additive):** the Firestore adapter is its own entry: add `"@core/sync/firestore":
  "https://core.anawj.com/sync/1.5.0/sync/firestore.js"` to the import map (and `sync\/firestore` to a Vite alias)
  only to pass `sync({ adapter: firestore({ ... }) })`; with no `adapter` nothing changes. Two things to check on the
  move: a service worker's precache list built by following only static imports misses `src/firestore.js` (now loaded
  by `import()`): follow `import()` too or read `entries.json`; and an import of an `app-sync/src/<file>.js` path
  outside `files.json` (internals such as `core.js`, `runner.js`) no longer resolves; the public modules
  (`app-sync/store.js` and the rest) still do. `whenText` with no `timeZone` now uses the device's.

## B. The Worker, rules and members (apps with their own Worker and roles; app-starter #48)

- **Member removal goes through the Worker**: `/api/members/<uid>` (`worker/members.js`): an admin sets a role (PUT,
  `v + 1`) or removes someone (DELETE: the doc goes, then `revoked/{uid}`, claims cleared, refresh tokens ended).
  Nobody changes their own doc there. Rules: pages can no longer write or delete `members/`; `cloud.js`'s
  `members.setRole` / `members.remove` call the route. An app that wrote `members/` from the page copies the Worker
  file, the rules lines and the `cloud.js` calls from app-starter, and moves its rules test with them.
- **Writing personal files needs a role** (admin or member in some group); an account with no role gets 403.
  A live smoke that signs in as a test user must have the role.
- **firebase-tools 15.33.0** for the rules emulator: `npx -y firebase-tools@15.33.0 emulators:exec --only firestore
  --project demo-<app> ...` (app-starter `package.json`, `rules`). Java 21 is needed.
- **app-devkit** workflow blocks at an exact tag (app-starter uses `v1.11.0`: `setup-node`, `setup-tools`,
  `deploy-worker`); take the tag app-core records for base 1.

## C. The UI core: app-ui 1.0.0 (app-starter #50, sandbox-app #26)

The app deletes its own copy of the kit (`ui/`, `theme/`, `settings/`, `kit/` and their tests) and loads the same
files from app-ui. Five places change:

1. **Import map** (`index.html`): the three UI entries point at the core host; `@core/files` and `@core/search` stay
   the app's own until they move.
   ```json
   "@core/ui":       "https://core.anawj.com/ui/1.0.0/ui/index.js",
   "@core/theme":    "https://core.anawj.com/ui/1.0.0/theme/index.js",
   "@core/settings": "https://core.anawj.com/ui/1.0.0/settings/index.js"
   ```
   The `@core/app|auth|sync|update` entries move to `.../sync/1.4.0/...` in the same edit. The map is the page's one
   inline script, allowed by its hash: when the map changes, put the new hash in `worker/headers.js` (`IMPORT_MAP`;
   `worker/test/headers.test.mjs` prints the new one).
2. **Linked files** (`index.html`): `theme/early.js` (a classic script, it must run before first paint) and the style
   sheets `theme/theme.css`, `ui/ui.css`, `theme/glass.css` load from `https://core.anawj.com/ui/1.0.0/...`.
   The design tokens link (`design.flamingbeing.com/v1/tokens.css`) and the app's own `app.css` stay.
3. **CSP `style-src`** (`worker/headers.js`): add the core host: `'style-src': ["'self'", CORE, kit, FONTS_CSS]`.
   (`script-src` and `connect-src` already have `CORE` for app-sync; the app-ui sheets are what needs `style-src`.)
   Left out, the browser blocks every app-ui sheet and the page renders unstyled.
4. **Service worker file list** (`sw.js`): `SHELL` no longer lists the deleted `ui/`, `theme/`, `settings/`, `kit/`
   files; it gains the `https://core.anawj.com/ui/1.0.0/...` entries for every file the three entries load plus the
   linked sheets and `early.js`. Do not hand-edit: `node tools/sw-files.mjs app` writes it (and `--check` is in CI).
   Three more edits in `sw.js`: the `pinned` runtime rule's pattern becomes `/(sync|update|ui)\/\d+\.\d+\.\d+\//`
   (cache-first for the new host path); the `KIT_PAGES` regex and its `never` entry go (the gallery is app-ui's now);
   the header comment says app-ui. `tools/sw-files.mjs` reads both packages at the pinned version
   (`node_modules/app-sync`, `node_modules/app-ui`); take the updated tool from app-starter.
5. **tsconfig and package.json**: add the devDependency `"app-ui": "github:flamingbeing/app-ui#v1.0.0"` (the same tag
   as the import map; `app-sync` likewise `#v1.4.0`). In `tsconfig.json` the three paths point into it, `include`
   drops the deleted folders, and the type checker needs `"maxNodeModuleJsDepth": 3`:
   ```json
   "paths": {
     "@core/ui": ["./node_modules/app-ui/ui/index.js"],
     "@core/theme": ["./node_modules/app-ui/theme/index.js"],
     "@core/settings": ["./node_modules/app-ui/settings/index.js"],
     "@core/*": ["./node_modules/app-sync/types/*.d.ts"],
     "app-ui/*": ["./node_modules/app-ui/*"]
   }
   ```
   (`@core/*` stays last: the more specific paths win.)

Also: delete the app's copies of the kit's unit and browser tests and docs (they live in app-ui now); the app keeps
tests of its own screens. An app with its own `theme/` or `ui/` changes (a fork) lists them first: those become app-ui
changes or app-side files, never a second copy under the same name.

## D. Pins: one place each

The version appears in the import map, the `sw.js` list (generated), the two devDependencies, `tsconfig` paths,
the CSP hash, and any test helper that loads the engine (rosters has three). `grep -rn "core.anawj.com/\(sync\|ui\|update\)/"`
and `grep -rn "app-sync\|app-ui" package.json` must show only `1.4.0` / `1.0.0`. A later bump is the same edit with
the new tag; `sw-files.mjs --check` and the header test catch a missed spot.

## E. Check

- The app's own unit and e2e tests, `npm run typecheck`, `node tools/sw-files.mjs app --check`, the header test, the
  rules test, `vite` build where the app has one.
- In the browser: the page shows `VERSION` `1.4.0` (`app.js`) and `1.0.0` for the kit; no CSP report in `/api/csp`;
  offline start works after one online visit (the new `ui/` files are in the cache); the sync status chip and a
  sign-out round trip behave as before.
- Screenshots at 390 and 1280 px in the PR (the ui-core rule).
- Cheap-Android stand-in: the Solid switch in Settings still turns glass off.

## Per app (effort to move to base 1; engine pins as read from each app's code 25 Oct 2026, re-check at the start)

Effort: **S** about 25 turns (Sonnet), **M** about 45, **L** about 60+ (Opus where vital). The UI step (C) is
mechanical in every app; the rest of the effort is the app's own screens moving onto the kit parts and the data step.

| App | Pins now (sync / update) | Data work (the 1.0 steps below, still due) | UI work | Effort | Vital |
|---|---|---|---|---|---|
| pantry | 0.6.3 / 0.2.0 | 1.0 split of `backend` (server stamps, merge), `stores.metaOnly`, `hub` (`bin: null`, `unstamped`, `expire`, `stampMode: 'client'`), `report`, `commit`, `onRefused`, `redirectFirst`; sign-out `app.signOut()` (wipes) -> `auth.forget` | household list screens, photos, settings sheet | **M** | no |
| kakihome | 0.7.3 / 0.2.0 | `device`, `backend` (`held`, `edits`, `merge`, `onCommit`), `stores.metaOnly`, `hub`, `queue.otherPending`, `onRefused`, `redirectFirst`; `leaveEntry` from `@core/sync`; sign-out wipes | feature-frozen, pantry-shaped: copy pantry's screens | **S** (after pantry) | no |
| rosters (three apps, one shared `docsync`) | 0.6.3 / 0.2.0 | `commit`, `adapter` (no-op listen), `scope`, `nav`, `queue` (`labels`, `delay`), `claims` (`url`, `when`, `behind`, `entry`), `forget.extra`; pins also in each app's test helpers | three large-document apps; staff names stay in the private repo | **L** (3 apps, one shared module: do the module once) | no (Dr Chew's roster: list only) |
| prewarm | 0.6.3 / 0.2.0 | `kinds`, `scope`, `report`, `watchEvery`, `backend` (server stamps, `where`, `merge`, `onCommit`), `stores`, `outbox`, `hub` (`feeds`, `onLeave`, `onError`); own `forgetDevice` on `app.parts`; its own sign-in stays app-side | busiest screen needs the dense/extra-dense parts | **L** (Opus, full tests, no live case) | **yes** |
| residencyapps | 0.6.3 / 0.2.0 | `nav`, `outbox`, `storage`, `watchEvery: 0`, `backend` (merge, `stamp`, server stamps), `queue.otherPending`; no update module yet (add `update({...})` + `sw.js`) | small (1.6k lines) | **M** (Opus, not in a selection round) | **yes** |
| apmes logbook | 0.7.3 / 0.2.0 | `kinds`, `outbox`, `commit`, `watchEvery: 0`, `backend`, `stores` (`prefix`, `realm`), `queue`, `storage`; its own sign-out; its sync test imports internal names from `index.js` (1.0 step 5) | add-ons ported first (ui-core L1), saved themes and `#t=` links kept | **L** (after L1) | **yes** |
| apmes evals / people | 0.7.3 / 0.2.0 | evals: `kinds`, `commit`, `watchEvery: 0`, `queue`; `app.signOut({ wait })`; people shares evals' `cloud.js` | admin and evaluation screens | **M** (together) | no (staff data) |
| apmes ccc | 0.7.3 / 0.2.0 | `commit`, `outbox`, `watchEvery: 0`, `nav`, `storage`, `queue`; anonymous rater page: `sync` only, queue parts directly | rater page | **S-M** | no |
| hand-log, hand-babies, cmcj, owner-tools | none | none (browser-only or static) | optional | not a move | no |

The consumer matrix runs each app's own tests on this engine in place of its pin: the app-starter rows block in every
PR's Checks; the other apps' rows run in Full checks (nightly, or by hand: Actions, "Full checks", Run workflow) and
until an app has moved, its row is red on 1.4 by design (report only).

## From 0.x to 1.0: the one-object `createApp` to the modules

1.0.0-rc.1 removed `createApp(options)` from `index.js` and the `src/internal.js` names `index.js` used to re-export.
The stored formats do not change ([FORMATS.md](FORMATS.md)): a phone that ran 0.6-0.9 keeps its device copy and its
unsent saves, and sends them after the move. An app pinned to 0.x keeps working until it moves (tags never change).

### The steps, for every app

1. **Pins: one version.** Load the entries from `https://core.anawj.com/sync/1.4.0/` (the 1.0 steps are the same on any 1.x) (`app.js`, `auth.js`,
   `sync.js`, `update.js`; an import map with `@core/app`, `@core/auth`, `@core/sync`, `@core/update` is the
   recommended way) and the update core from `https://core.anawj.com/update/1.4.0/` (`sw-core.js`,
   `register.js`): the same version for both. In `sw.js`, precache the files of the entries the page uses
   (`/sync/<v>/entries.json`), not `files.json` (that is `index.js`'s list only).
2. **One call becomes a list of modules.** Split the old options three ways:

   | Old `createApp(options)` | 1.0 |
   |---|---|
   | `name`, `sdk`, `storage` | `createApp({ config: { name, sdk, storage } })` |
   | `claims`, `popupOnly`, `redirectFirst`, `fetch` | `auth({ claims, popupOnly, redirectFirst, fetch })` |
   | `colls`, `path`, `kinds`, `scope`, `backend`, `adapter`, `commit`, `outbox`, `hub`, `stores`, `queue`, `onRefused`, `forget`, `report`, `device`, `outside`, `wake`, `watchEvery`, `nav`, `now`, `win` | `sync({ ... })` (same meaning; `src/core.js`) |
   | `register({ app, canReload, ... })` from update 0.x | `update({ register, app, canReload, ... })` |

   ```js
   const app = createApp({ config: { name: 'myapp', sdk }, modules: [
     auth({ claims }), sync({ colls, path, scope, backend }), update({ register, app: 'myapp', canReload }),
   ] });
   await app.ready;
   ```
3. **The api moved under each module.** `app.signIn`, `app.onUser`, `app.user`, `app.refreshClaims` are
   `app.auth.*`; `open`, `watch`, `watchDoc`, `save`, `flush`, `status$`, `conflicts`, `describe`, `resolve`, `track`,
   `heard`, `idle`, `queue`, `hub`, `parts` and the rest are `app.sync.*`.
4. **Sign-out keeps the data.** `app.auth.signOut()` signs out and keeps the device copy and unsent saves (they send
   at the same account's next sign-in). Where the old `app.signOut()` was used to clear a shared device, call
   `app.auth.forget({ force, before })` (refused with `reason: 'unsent'` while anything is unsent, unless `force`;
   `before` runs before the wipe). A different account signing in wipes the last one's data by itself (after
   `auth({ beforeSwitch })`), and is refused while that account has unsent saves (`app.auth.blocked()` says why).
   An app that called `forgetDevice(app.parts...)` itself can keep doing so, or move the extra step to
   `sync({ forget: { extra } })` / `forget({ before })`.
5. **Internal names.** A test that imported `plan`, `applyChanges`, `createCollectionSync`, the tuning constants or
   other `src/internal.js` names from `index.js` imports them from `src/internal.js` (no promise: they may change in
   any release). `index.js`'s named exports (`createSyncHub`, `createWriteQueue`, `persistGuard`, `syncStatus`, …)
   are unchanged.
6. **Check:** the app's own browser tests on the new pins; the version each page runs (`VERSION` from `app.js`) says
   `1.4.0`.

