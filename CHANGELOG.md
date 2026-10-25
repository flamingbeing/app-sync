# Changelog

## Toward 1.0

1.0 will be the engine and the update module released as one stack, under one CHANGELOG, with the promises in the
README ("Stability") and [FORMATS.md](FORMATS.md). The 0.8.x releases prepare it; each is additive unless it says so.

- 0.8.0: the lean public index, `src/internal.js`, the file manifest, the stored-format promise.
- 0.8.1: outside writes and the sign-in/sign-out hooks.
- 0.8.2: refused saves and job data that survive a reload, and the watch change info.
- 0.8.3: `watchDoc`, reconnect and wake, the claims watch. Stored formats only ever gain optional fields.
- 0.9.x: the modules (`createApp({ config, modules })`): 0.9.0 the runner and auth, 0.9.1 sync and update, 0.9.2 the
  entries, types and checks that freeze at 1.0, 0.9.3 two names the entries were missing, 0.9.4 a file list per entry and a refused listener that recovers.
- 1.0.0-rc.1: one version for the engine and the update module (`/sync/<v>/` and `/update/<v>/`), and the deprecated
  `index.js` aliases of `src/internal.js` removed. Then 1.0.0 on the same commit once the reference app runs on it.

## 1.3.6 (2026-10-26)

Fix, no API, module contract or stored-format change; modular: yes, shaken: no new export or option, the fixes are a
few lines in `src/auth.js`, `src/runner.js` and `src/signin/passcode.js` (the passcode method still has its own chunk).

- **A sign-out wins over a sign-in still out**: a passcode sign-in whose token came back after `signOut()` or
  `forget()` signed the account back in. A sign-in that was out when either came now signs nobody in and answers
  `{ ok: false, reason: 'refused' }`, whatever the method: an account that lands anyway (a popup, an SDK call already
  out, a method that signs in by itself) is signed straight out again, before any switch or `signin`. The passcode method hands its token to the auth
  module (`{ token }`, an optional field of a sign-in method's answer) instead of signing in itself.
- **A failed forget keeps the owner**: a module whose `forget` wipe threw still cleared the device's owner, so the next
  account's sign-in was no switch and the old account's rows stayed under the new one. The owner now stays when a wipe
  threw (`failed` names it, as before): another account's sign-in is a switch that wipes again.
- **`stop()` during the app's `beforeSwitch` ends the switch**: the switch went on after `app.stop()` and left a live
  claims watch; a stop during the switch's wipes still made the new account the owner. Once the app has stopped, nothing
  is wiped, the owner stays and nothing more is started.
- **A handler that stops the app ends the event**: `emit` ran the handlers after one that awaited `app.stop()`. It now
  stops there, as it already did for an event sent after stop.

## 1.3.5 (2026-10-26)

Fix, no API, module contract or stored-format change; modular: yes, shaken: no new export or option, the fix is a few
lines in `src/writes.js` (the outbox).

- **A forget waits for saves still being stored**: a sign-out wipe could run while a save's first write to the device
  was still out; the row then landed after the wipe. `forget()` now waits (4 s at most, a write that never ends does not
  hold the sign-out) for every write already started before it clears the store, and a save step that comes after the
  forget stores nothing. An account switch is unchanged: its unsent saves stay.

## 1.3.4 (2026-10-26)

Fix, no API, module contract or stored-format change; modular: yes, shaken: no new export or option, the fix is a counter
in `src/writes.js` (the outbox).

- **The sign-out check stays shut while a save is still being stored**: `flush()` ignored a save whose first write to
  the device was still out, so it could answer "nothing unsent" and let a sign-out wipe run; the row then landed after
  the wipe. A save not yet stored now counts as unsent.

## 1.3.3 (2026-10-26)

Fix, no API, module contract or stored-format change; modular: yes, shaken: no new export or option, the fix is three lines
in `src/sync.js` (the collection engine).

- **A check read never replaces a newer copy**: a record that left a query without a known deletion is read once to see
  whether it still exists; if a snapshot brought a newer copy of it while that read was out, the older answer replaced
  the newer one in the lists and the device copy. The read is now ignored when a snapshot changed the record while it was out.

## 1.3.2 (2026-10-26)

Fix, no API, module contract or stored-format change; modular: yes, shaken: no new export or option, the fix is one line
in `src/sync.js` (the hub).

- **Sign-out waits for an engine that is already stopping**: `stopAll()` stopped the running engines but forgot those
  whose grace period had ended and whose last local writes were still going, so it resolved and the stores were wiped
  while those writes were pending; they then reopened the wiped store and left the signed-out copy on the device.
  It now waits for them too.

## 1.3.1 (2026-10-26)

Fix, no API, module contract or stored-format change; modular: yes, shaken: no new export or option, the fix is inside
`src/writes.js` (a page not using the queue bundles none of it).

- **A second window's saves are noticed**: the write queue read the outbox once, when the account opened, so a save
  stored by another tab that then closed (offline) was never sent by the tab left open, and a held or refused save
  that the other tab had already settled stayed "waiting" here, shutting the sign-out check and the update reload until
  a reload. `kick()` (online, wake, `flush()`) now reads the outbox again: saves it had not seen are sent, settled ones
  are cleared; a refused save settled elsewhere too. `kick()` returns a promise (it returned nothing).

## 1.3.0 (2026-10-26)

Additive: no 1.0 name, module contract or stored format changes (FORMATS.md as 1.0: `public:` scopes were reserved
for this and hold a device copy like any scope, never an outbox job; no new stored key: the owner keeps its
`{ uid, email }`). Built on the SHAPES.md reservations 7 and 8, each piece with a failing test first.

- **Sign-in methods** (SHAPES.md 8; `src/signin/`): `auth({ methods })` (default `['google']`) takes `emailLink()`,
  `password()`, `passcode({ url })` and `anonymous()`, each its own named export of `auth.js`, or their SHAPES.md
  string names (loaded by a literal `import()` the first time `signIn` asks; `'passcode'` has no `url`, so it throws
  there). `signIn({ method, email, password, code })`; new reasons `'sent'` (the email link is on its way) and
  `'refused'` (the passcode was not taken). A method not named throws. Signed in anonymously, another method links
  its account to the anonymous one (`linkWithCredential`, Google's `linkWithPopup` / `linkWithRedirect`): the uid
  stays, so do the device's data and unsent saves, no switch; the owner and `onUser` get the email. A credential
  whose account exists signs in instead (a switch, guarded as any). A passcode POSTs `{ code, email? }` to `url` and
  signs in with the `{ token }` it gets (a custom token: it always signs in).
- **Public read** (SHAPES.md 7): `sync({ public: [coll] })` (each in `colls`, else `sync()` throws): those collections
  are watched in scopes named `public:<name>` with no sign-in, and only those there. The watches run signed out, are
  listened again at sign-in (under the account's rules; the hub's new `stopScope(scope)`), and stay through a switch
  or `forget()`: their copy is wiped with the rest, then they start again (after a switch at the new sign-in; not
  when the page must reload). `open`, `save` and `saveMany` on a `public:` scope throw "read only".
  The watchdog's relisten now starts only the watches that were running, so one while signed out (a public watch
  still listening) leaves the account's paused ones paused.
- Tests: `test/signin.emulator.mjs` (in `npm run test:emulator`): each method on the Auth emulator (the email link
  from its oobCodes, the passcode's custom token unsigned), anonymous then password keeping the uid and an unsent
  save, and a public watch with no account.
- **Size budget:** `src/` 276000 -> 290000 bytes, for the four sign-in methods and public read.
- `entries.json` (auth) gains `src/signin/*.js`; `files.json` / `FILES` unchanged (no new `index.js` import).

Modular: yes (no new entry, global or ctx field; the modularity check, types and both Vite builds pass). Shaken: the
Vite fixture names `password()` only, and `test/vite/build.mjs` checks that its entry chunk has password's code and
none of email link's, passcode's or anonymous's, which sit only in the lazy chunks their string names load. Public
read is an option inside the sync module (no code of its own to shake).

## 1.2.1 (2026-10-26)

Fix, no API, module contract or stored-format change; modular: yes, shaken: no source change in `src/` or the entries.

- **Pre-release paths served**: the Worker's version pattern took only `x.y.z`, so `/sync/1.0.0-rc.1/` and
  `/update/1.0.0-rc.1/` returned 404 although `versions.json` lists them; it now takes the same shape as `VERSION_RE`.

## 1.2.0 (2026-10-26)

Additive: no 1.0 name, module contract or stored format changes (FORMATS.md as 1.0; no new job state; the outbox job
keeps no path: a kind's path is asked at each send). Each piece lands with a failing test first.

- **`kinds: { [kind]: { coll, path } }`** (`src/kinds.js`): a kind saved to `path(scope, coll, record)` instead of the
  scope's path (a record kept outside the scope), through the same queue, outbox, conflict check and report; the
  adapter's commit takes it as `extra.path`. A bad kind fails at `sync()`, not at the first save.
- **`backend.unstampedColls: [coll]`** (`firestore.js`): collections whose documents hold only the app's fields (rules
  that refuse `id`, the stamp and the server stamp): written without them, the conflict check on the content alone,
  and always listened to whole (no stamp to read "changed since" by). Naming a merge or held collection throws.
- **`watch(scope, coll, cb, { listen })`**: the app's own listener for that collection (the adapter's `listen` shape)
  instead of the adapter's; its snapshots go into the device copy and feed the status, `facts()` and the watchdog as
  the adapter's do. One way at a time per collection: another `listen` for it throws while it runs; a plain watch of
  it joins the app's listener (those watches start first).
- **`facts().inStepAt`**: the last time the status was synced (the server heard, nothing waiting), now while it is;
  0 before.
- **`sync({ reopen: async ({ memory, sdk }) => db })`**: after a wipe ends the SDK instance (a switch of account,
  `forget()`), a new Firestore instance in its place, so the page need not reload: a persistent cache once the old one
  was cleared, else (or when that won't open) a memory-only one, so the last account's cache is never read again. It
  becomes the `db` of the SDK every module shares (`ctx.sdk()`, the auth module's claims watch too). Both failing: the
  page reloads, as without `reopen`.
- `entries.json` (sync) gains `src/kinds.js`; `files.json` / `FILES` unchanged (no new `index.js` import).

Modular: yes (no new entry, global or ctx field; the modularity check, types and both Vite builds pass). Shaken: none
of the five has code of its own to shake: `kinds.js` is part of the sync module every sync page loads, and the rest
are options inside the sync api, the module and the adapter.

## 1.1.0 (2026-10-26)

Additive: no 1.0 name, module contract or stored format changes (FORMATS.md as 1.0; no new job state). Each piece
lands with a failing test first.

- **`sync.saveMany(kind, scope, records)`** (SHAPES.md 5): one result per record (`Promise.allSettled`'s), each saved
  as `save()` saves it (the outbox, the stamp, `onCommit` bin entries, held conflicts per record), on the copy this
  device shows (`copyOf`) as its base: a record changed elsewhere since is its own conflict; the rest still land.
- **`watch(scope, coll, cb, { query, limit })`** (SHAPES.md 4+, `src/view.js`): cb gets only the records whose fields
  equal `query`'s, the first `limit` of them; `changed` / `removed` / `copyOf` are of that view (one leaving it is in
  `removed`). The device copy and the listener stay whole. `copyOf` now asks every running watch of the kind.
- **`backend.merge['*']`**: the merge of every collection not named (`false` on a name keeps its conflict check),
  and **`replaceRecord`** (`index.js`, `sync.js`; `src/replace.js`): a merge function that writes a save over the
  server's copy whole, `backend: { merge: { '*': replaceRecord } }`, for apps that wrapped the merge option in a Proxy.
- **`backend.commitRetry: { codes = ['aborted', 'permission-denied'], delay = 500 }`**: a commit refused with one of
  codes is tried once more after `delay` ms (a rule that reads a document another write is still creating); off by
  default, as 1.0.
- `entries.json` (sync) gains `src/view.js` and `src/replace.js`; `files.json` / `FILES` gain `src/replace.js`.

Modular: yes (no new entry, global or ctx field; the modularity check, types and both Vite builds pass). Shaken: the
Vite source fixture imports `replaceRecord` unused and asserts it is not in the bundle; `saveMany`, the watch view and
`commitRetry` are parts of the sync api and adapter every sync page loads (no code of their own to shake).

## 1.0.0-rc.1 (2026-10-25)

The first 1.0 candidate. **Breaking** for apps on the one-object `createApp(options)` (they move to the modules:
[MIGRATING.md](MIGRATING.md)); no stored-format change, so phones keep what they hold across the move. Apps pinned to
0.x keep working (tags never change).

- **Removed:** the one-object `createApp(options)` (`src/app.js`, deprecated since 0.9.0) and its `index.js` export, and
  the deprecated `export *` of `src/internal.js` from `index.js` (`plan`, `applyChanges`, `createCollectionSync`,
  `watchSaved`, `decide`, the tuning constants, …: import `src/internal.js` itself, with no promise). `userOf` and
  `claimsBehind` stay public (now from `src/user.js`). `files.json` / `FILES` shrink to what `index.js` still loads.
  The sync options are documented in `src/core.js`, the sign-in ones in `src/auth.js`.
- **One version:** the update module (`update/`) now has the engine's version. The tag `v1.0.0-rc.1` serves
  `/sync/1.0.0-rc.1/` and `/update/1.0.0-rc.1/` (`sw-core.js`, `register.js`; `CORE_VERSION = '1.0.0-rc.1'`, the same
  bytes as update 0.2.0 otherwise). `update/VERSION` and `update-vX.Y.Z` tags stop; `/update/0.1.0/` and `/update/0.2.0/`
  stay served. `tools/build-update.mjs` builds both kinds of tag, `release.yml` checks that `app.js` and the update core
  carry package.json's version, and pre-release tags (`v1.0.0-rc.1`) build and sort before their release;
  `versions.json`'s `latest` stays the last stable version.

### The 1.0 promise (from 1.0.0; additive only until 2.0)

- **Module contract:** `createApp({ config, modules })` -> `app` (one key per module's api, plus `ready`, `stop()`,
  `status$`); a module is `{ name, needs, start(ctx, deps) -> api, stop() }`, started in `needs` order, stopped in
  reverse, failing fast on a cycle, a missing or a duplicate name; `deps` holds only the apis named in `needs`.
- **ctx:** `name, module, config, sdk(), user(), on(event, fn), emit(event, data), storage(ns), status, report(fact),
  ready`. Events: `signin { user }`, `signout { user }` (keeps the data), `switch { from, to }` (another account: the
  old data is wiped), `forget { user, force }`. Sign-out never wipes; `auth.forget()` and a switch are the only wipes,
  both refused while anything is unsent unless forced.
- **Entry names:** `/sync/<v>/app.js`, `auth.js`, `sync.js`, `update.js` (import-map names `@core/app`, `@core/auth`,
  `@core/sync`, `@core/update`; reserved: `@core/files`, `@core/ui`, `@core/theme`, `@core/settings`, `@core/sw`,
  `@core/devkit`), each with its `.d.ts` under `types/`, `entries.json` and `files.json`, and `/update/<v>/sw-core.js`
  and `register.js`. Everything `index.js` names. Each module's api and options as its header comment gives them.
- **Types:** the generated `.d.ts` (strict JSDoc) and package.json `exports` with `types`; 1.x only adds to them.
- **Formats:** [FORMATS.md](FORMATS.md) (device copy, outbox job, storage namespaces, the scope a record was fetched
  by): no new job state, renamed key, prefix or field before 2.0. The 1.x additions are written down in
  [SHAPES.md](SHAPES.md) (sign-in methods, a no-sign-in scope, partial device data, bulk saves, watch queries, files).
- **SDK range:** the app passes its own Firebase JS SDK (modular API, `A` and `F` functions); 1.x supports Firebase
  11.x (tested: 11.10.0). A newer SDK major is added in a 1.x release after the tests pass on it, never by dropping 11.x.
- **Release:** a tag never changes; 1.0.0 follows this candidate, with no change to the contract above, once the
  reference app runs on it.

## 0.9.4 (2026-10-25)

Additive: no stored-format change, no change to the module contract, every 0.9.3 name unchanged.

- `entries.json` (served at `/sync/<v>/entries.json`, next to the unchanged `files.json`): the files each entry loads,
  `{ app, auth, sync, update }`, each a sorted list that includes the entry itself. A page that imports only some entries
  can precache or vendor exactly those without walking the imports. `files.json` still lists `index.js`'s graph only.
  `test/freeze.test.mjs` checks both against the real imports. Documented in FORMATS.md.
- Sync: a listener the server refused with `permission-denied` no longer stays silent for good. The collection and bin
  engines remember the refusal, and the next `replan()` (page shown again, back online, or the periodic replan) listens
  again, so a role or rules change takes effect without a reload. A healthy listener is still left alone. Test first
  in `test/sync.test.mjs`.
- `checks.yml`: the starter's pinned-engine step also looks in `app/app/index.html` and `app/app/public/sw.js` (the starter's
  own `app/` folder inside the checkout), where the modules-only starter keeps its import map.

## 0.9.3 (2026-10-25)

Additive: a modules-only app (one that imports only the entries, never `index.js`) gets the two names it needed from
`index.js`. No `src/` change, no stored-format change; every 0.9.2 name is unchanged.

- `app.js` exports `VERSION` (the same value as `index.js`; `test/freeze.test.mjs` checks they agree), so an app and
  the consumer checks can tell which engine a modules-only page really ran.
- `sync.js` exports `leaveEntry` (the delete-to-bin entry, the same function as `index.js`'s).
- Types: `types/app.d.ts` and `types/sync.d.ts` carry both (`test/types/consumer.js` uses them through `@core/*`).
  `files.json` is unchanged (it lists what `index.js` loads, and that graph did not change).
- Checks: the mixed-version spec accepts a page that loaded `/sync/<v>/app.js` as having run the engine, not only
  `index.js`; the consumer job reads the starter's pinned version from the import map in `index.html` (root layout),
  else `public/sw.js`, else `app/sw.js` (the 0.x layout keeps working), and fails clearly if none pins one. The
  consumer matrix uses app-devkit v1.9.1 (serve-candidate checks a page's `app.js` entry too).

## 0.9.2 (2026-10-25)

The freeze: entries, types, formats and the checks that hold them until 2.0. No behaviour change: every `src/` file
minifies to the same bytes as 0.9.1 (the edits are JSDoc only), and stored formats are unchanged (FORMATS.md now says
which scope holds a record, and reserves optional fields). Tests: `test/modularity.test.mjs`, `test/formats.test.mjs`
(new), `test/types/` and `test/vite/` (new fixtures).

- **Entries and the import map:** `app.js`, `auth.js`, `sync.js`, `update.js`; the import-map names `@core/app`,
  `@core/auth`, `@core/sync`, `@core/update` are frozen. Reserved, nothing built: `@core/files`, `@core/ui`,
  `@core/theme`, `@core/settings`, `@core/sw`, `@core/devkit`. The UI reads only the modules' public APIs; the engine
  never knows the UI (README "Entries, the import map, types and Vite").
- **Types:** `tsconfig.json` is `strict` (JSDoc, TS-erasable style); `types/` (new, published with each version at
  `/sync/<v>/types/`, which the Worker now serves as text) holds the `.d.ts` generated by `npm run types`; Checks fail
  when it is stale, and type-check a page that imports `@core/*` through `paths`.
- **Package:** `package.json` `exports` per entry (`.`, `./app`, `./auth`, `./sync`, `./update`), each with `types`;
  `./*` (`src/`) kept. Installable from a git tag.
- **Modularity check** (`tools/modularity.mjs`, in Checks): side-effect-free entries, no top-level await, no import of
  another module's entry, literal `new URL()` and `import()` only (a literal `import()` is checked like a static import), `.js` extensions.
- **Vite check** (Checks job `vite`, Vite a dev dependency only): a page with an import map builds (a) with core
  external by URL, (b) with core bundled from source, where an unused `update` import is shaken out, and (c) from the
  package installed from the commit's git ref. Bare `@core/*` names need one alias in a bundler (README).
- **FORMATS.md:** "Which scope holds a record" (frozen): the database name carries the scope, the record is stored as
  sent, deletes are only tombstones (eviction is not a delete); reserved for 1.x: `meta.keep`, `meta.fetchedBy`,
  `public:` scopes. The frozen sections are pinned by hash (`test/formats.test.mjs`).
- **SHAPES.md** (new): how bulk save, files, public data, the other sign-in methods, keeping part of large data and
  watch with a query or limit add in 1.x without changing a 1.0 name or format; their types are reserved in
  `src/types.js` (types only).
- **Size budget:** `src/` 272000 -> 276000 bytes, for the strict JSDoc and the reserved types (comments only).

## 0.9.1 (2026-10-25)

The sync and update modules. Additive; the one-object `createApp(options)` is unchanged and still deprecated. Stored
formats only gain one key (FORMATS.md). Tests: `test/modules.test.mjs` (new: the createApp tests again, on
`createApp({ config, modules: [auth(), sync()] })`, plus the sync module's own), `test/update-module.test.mjs` (new).

- **`sync.js`** (new entry): `sync({ colls, path, kinds, scope, backend, adapter, ... })`, needs auth: the one-object
  createApp's sync (the device copy, the outbox and queue, watch, watchDoc, save, flush, track, conflicts, describe,
  resolve, reconnect, wake, status, facts), built on the same code (`src/core.js`, moved out of `src/app.js`) and the
  same stored names (`<name>-sync:`, `<name>-outbox`), so phones keep what they hold when an app moves over.
  `scope(user)` opens the account's scope at each sign-in. Sign-out keeps the device copy, the outbox and the watches,
  and nothing sends until the same account is back (then its kept saves send at once); a switch or `forget()` wipes
  the last account's device copy, outbox (in every outbox on the origin) and the SDK's cache, and throws when that
  fails (the auth module then refuses the switch), or while that account has unsent saves anywhere on the device
  (this tab, another tab's in the shared outbox, another app's on the origin: the one-object sign-out check; reason
  `'wipe'`; `forget({ force })` wipes anyway, the `forget` event now carries `force`). A save counts as unsent in the
  status from the moment it is made. After a wipe cleared the SDK's cache the page reloads (`reload`
  option): after a switch at the new account's sign-in, after `forget()` straight away. The scope last opened is kept
  (`<name>:sync/scope`), so a reload, signed out, still counts its unsent saves and a switch waits for them.
- **`update.js`** (new entry): `update({ register, app, sw, every, canReload, beforeReload, retryOn })` wraps the update
  core's page side (register.js, passed in; the update module still releases on its own). The take-over reload and
  `forceLatest()` wait while any module has unsent saves, as well as for the app's `canReload` (checked again after it); `retryOn` names events
  after which the owed reload is tried again; `checkNow({ wait })` looks for a new version now and resolves true once it
  takes over, false when none is found or it is still held. The worker is registered after start (app.ready never
  waits on the network).
- `tools/check.mjs`: the `src/` budget is 272000 bytes (was 262000): the two modules.

## 0.9.0 (2026-10-25)

The module runner and the auth module: the 1.0 shape, `createApp({ config, modules })`. Additive; the one-object
`createApp(options)` of `index.js` is unchanged and **deprecated** (removed in 1.0.0-rc.1; apps pinned to 0.x keep it).
Stored formats only gain one key (FORMATS.md). Tests: `test/runner.test.mjs`, `test/auth.test.mjs`,
`test/auth.model.test.mjs` (new).

- **`app.js`** (new entry): `createApp({ config, modules })` -> `app`, one key per module (its api), plus `ready`,
  `stop()` and `status$`. A module is `{ name, needs, start(ctx, deps), stop() }`: started one at a time in `needs`
  order, stopped in reverse (`stop()` once, however often it is called); a cycle, a missing or duplicate name throws
  at once. `ctx` (frozen, one per module): `name, module, config, sdk(), user(), on(event, fn), emit(event, data),
  storage(ns), status, report(fact), ready` (`ready` resolves once every module has started; a module holding unsent
  saves reports them in `status` before its start resolves). Events `signin`, `signout`, `switch`, `forget` (emitted
  by the auth module, awaited in start order).
- **`auth.js`** (new entry): `auth({ claims, beforeSwitch, popupOnly, redirectFirst })` with `signIn({ hint })`,
  `signOut()`, `forget({ force, before })`, `onUser`, `user`, `blocked`, `refreshClaims` (the claims and the claims
  watch as in 0.8.3). **Sign-out keeps the device's data**: the device copy and unsent saves stay and send when the same
  account signs in again. Another account signing in is a `switch`: the app's `beforeSwitch`, then the old data wiped,
  then `signin`; refused (the new account signed out again, nothing wiped, `blocked()` says why) while the old account
  has unsent saves, also one made during `beforeSwitch` (`reason: 'unsent'`), or when a module's wipe throws
  (`reason: 'wipe'`: the old account stays the owner, the next sign-in tries again). Each tab compares Auth's
  account with the owner whose data it holds, so a tab still switches after another tab already did. `forget()` is
  the wipe on purpose (refused while unsent unless `force`, checked again after its `before`). Auth's answers wait for
  every module to start (`ctx.ready`): found by the model test, a page opening with another account in Auth (signed
  in from another tab) could otherwise switch before a slow module had reported its unsent saves or listened for
  the wipe. A refused switch tells `onUser` (null) and emits `signout` for the account it replaced at once.
- `userOf` and `claimsBehind` moved to `src/user.js` (still exported from `index.js`, same values).
- Size budget for `src/` raised from 240000 to 262000 bytes (the runner and the auth module; the old createApp goes
  at 1.0).

## 0.8.3 (2026-10-25)

One document, reconnect, wake and the claims watch. Additive; no stored format changes. Tests: `test/app.test.mjs`
(+8), `test/firestore.emulator.mjs` (+1).

- **`app.watchDoc(path, cb, onError)`**: one document (path as segments or `'a/b'`), `cb(doc | null, meta)` when its
  copy changes. `null` ("gone") comes once, only when the server says the document is not there or the listener fails
  (then `onError(e)` too; that watch is finished), never from the device copy alone. It feeds `facts()`, the status
  and the watchdog, which restarts it like the lists; sign-out stops it (and the claims watch) before its `before`
  hook and the wipe, and starts it again if the sign-out stops. The Firestore adapter gains `listenDoc`
  (an injected adapter needs one for `watchDoc`).
- **`app.reconnect({ why })`**: restarts the connection (the SDK's network off and on, as the watchdog does) and
  resolves `true` after it, then sends what waits. `false` offline, without the switch, or while a write outside the
  queue is unsent (a restart may send it twice), checked again just before the switch (the watchdog's restart too).
  One restart at a time: a call during one shares it, until the switch itself settles (also one past the 4 s cap).
- **`wake: true`** (createApp, default off): `online`, `pageshow` and the page shown again nudge the watchdog
  (`nudge('wake')`) and send what waits.
- **Claims watch:** `claims: { watch: true, doc: user => path }` reads the role doc live (the default `entry`; nothing
  is asked before its first answer) and checks the token again whenever it changes; stopped at sign-out.
  `claims.onClaims({ asked, status })` after each check: whether new claims were asked, and the HTTP status (0: none).
- `replanOnWake`'s timer no longer keeps a Node process alive (`unref`; no change in a browser).

## 0.8.2 (2026-10-25)

Refused saves and job data that survive a reload, and the watch change info. Additive; stored formats only gain
optional job fields (FORMATS.md), no new job state. Tests: `test/writes.test.mjs` (+4), `test/app.test.mjs` (+2).

- **Refused saves** (queue): a failed save keeps the error's `code` on the job, after a reload too (createApp's
  `onRefused` reads it there; before, it was kept in the page's memory and a refused save found after a reload said
  `code: ''`). `onRefused` returning `'archive'` now sets the save aside with `refused: true` on the `archived` job:
  kept out of the history's pruning, listed by `queue.refused(kind?)` (with the failed ones), sent again by
  `queue.retry(key)` (in its own place: a newer save made since meets it through the conflict check) or given up by
  `queue.discard(key)`. `queue.archive(key, { refused: true })` does the same by hand.
- **Changed:** a refused save set aside that way keeps the sign-out gate shut (`flush()` false, `signOut` reason
  `'refused'`, also through the origin's registry) until the person retries or discards it, or `signOut({ force })`:
  the outbox is now its only copy. Before, `'archive'` opened the gate (the app kept its own copy).
- **Job data:** `save(kind, scope, record, base, { ops, meta })`: `meta`, the app's own data about the save, is
  stored with the job and returned by `entries()` and `queue.finished(key)` (the job once synced or set aside, null
  before), after a reload too.
- **`queue.lastSent(kind, id)` and `app.lastSeen(kind, id)`**: `{ stamp, signature }` of the copy this device last
  sent (from the device history: the last 100 finished saves) and of the server's copy as last heard (the device
  copy after a reload). Different signatures: someone else saved since. Queue option `field` (createApp passes the
  backend's) names the stamp.
- **Watch change info:** `app.watch` (and `watchSaved`) callbacks' meta gains `{ changed, removed }`: the ids whose
  copy differs from the last list handed (all of them the first time) and the ids gone. `app.copyOf(kind, id)`: that
  record as last handed, at once.
- Promised from `queue` (README): also `refused`, `retry`, `discard`, `entries`, `finished`, `lastSent`.

## 0.8.1 (2026-10-25)

Outside writes and the sign-in/sign-out hooks. Additive, except one `signOut` reason (below). Tests:
`test/app.test.mjs` (+15).

- **Writes outside the queue, one concept** (createApp): `app.track(promise, { kind, id })` counts a write the app
  sends another way (straight to the SDK) as unsent until it settles; `app.unsentOutside(kind?, id?)` is their count,
  a number at once; `app.outsideSettled(ms)` waits for them. They keep the status at saving, `flush()` and the
  sign-out gate shut, `idle()` false and the watchdog from restarting the connection under them; with `kind` and `id`,
  a delete heard from elsewhere waits for that record. `createApp({ outside: () => number })` adds writes the app
  counts itself (an older version's leftovers in the SDK's queue). Deprecated, still working until 2.0:
  `createApp({ quiet })` (false counts as one outside write) and `queue: { otherPending }`.
- **`app.heard(meta)`**: a read or listener the app runs itself answered; it sets `facts().confirmed` / `heardAt` and
  feeds the status and the watchdog (`{ fromCache: true }` does not confirm).
- **`app.idle()`**: nothing being stored, sent, held in the queue or written outside it, for an update's `canReload`.
- **`signIn({ hint, popupOnly, redirectFirst })`** per call: `hint` goes to Google as `login_hint`; the other two
  override the createApp options for that call.
- **`signOut({ wait, force, before })`**: `force` signs out anyway once the user chose to (after the wait; unsent
  saves in every registered outbox and outside writes are forgotten with the device; someone else signed in
  meanwhile still stops it). `before` is the app's own step, run after every listener stopped and before anything is
  wiped (its own listeners, the Auth sign-out); a throw is named in `failed` and the sign-out goes on. It never runs
  when the gate refuses.
- **Changed:** `signOut` says `reason: 'refused'` (was `'unsent'`) when a save the server refused waits for the
  user's Retry or Discard. Code that checks only `ok` is unaffected.
- **One gate** (documented, test added): every outbox registered on the origin, this app's outside writes and its own
  queue are checked before the app's own lists (`forget.extra`) are touched.
- **What `hub`, `queue` and `parts` promise:** `queue.{ onChange, pending, status, error, unsent, conflicted }` and
  `hub.drop`. The rest is an escape hatch with no promise; an app's own sign-out steps go in `before`.

## 0.8.0 (2026-10-25)

Freeze prep. Nothing removed: every 0.7.4 import still works. Tests: `test/freeze.test.mjs` (+4).

- **Lean public index.** `index.js` names only the promised API (README "Modules"). Engine internals (`plan`,
  `applyChanges`, `replaceAll`, `applyTombs`, `dropTombs`, `pruneGone`, `binTombs`, `expireDocs`, `timeOf`,
  `createCollectionSync`, `createTombFeed`, `planServer`, `decide`, `clashingFields`, `mergeClashes`,
  `mergeFnClashes`, `keysOf`, `whenText`, `buildReport`, `errorCode`, `watchSaved` and the tuning constants) moved to
  `src/internal.js`, with no promise. They still load from `index.js` until 1.0.0 (deprecated).
- **File manifest.** `FILES` (in `index.js`) and `sync/0.8.0/files.json` list every file this version loads (index.js
  and its imports, `src/internal.js` included), for a service worker's offline list instead of a hand-copied one.
  A test checks it equals the import graph.
- **Stored-format promise** ([FORMATS.md](FORMATS.md)): device keys and prefixes, the outbox list, the job shape and
  states, the Firestore engine fields. New: every new job carries `v: JOB_FORMAT` (1); `JOB_FORMAT` and `JOB_STATES`
  exported. Jobs without `v` (written before 0.8.0) read as before; older versions ignore the field.
- **Core admission rule and size budget** (README "Stability", AGENTS.md): `tools/check.mjs` fails past
  2,600 bytes for `index.js` or 240,000 for `src/`.

## 0.7.4 (2026-10-25)

Fix: held conflicts on a map keyed by something with a '.' in it (an email: `names['a.b@example.com']`). A clash's
path joined its keys with '.' and was split on '.' again, so `describe()` showed the wrong values (nothing) and
`resolve` with theirs on a merge collection wrote junk nested keys (`names.a.{ b@example: { com } }`). Tests:
`test/held.test.mjs` (+3), `test/model.test.mjs` (dotted keys in tasks and in the merge collection's own fields,
answers per field).

- A path now has a backslash before each '.' or backslash inside a key: `names.a\.b@example\.com`. Paths whose keys
  have neither read exactly as before, so `describe` / `resolve` / `error.fields` keep their shape; an app that
  builds a path itself for a dotted key (a choice object, `held` counters) escapes it with `pathOf`.
- `describe()` fields also carry `keys` (the path as its keys, for labels); `pathOf(keys)` and `keysOf(path)` are
  exported.
- Unchanged: `_edits` keys are top-level field names, stored as they are (a dotted top-level name included).
- Documented, unchanged: `conflicts()` lists each record's first held save (its key is the one describe/resolve
  take); the newest save behind it is "mine".

## 0.7.3 (2026-10-25)

createApp gaps found moving apps onto it. Additive, except `flush()`, which now keeps to its time and answers truly.
Tests: `test/app.test.mjs` (+3).

- `createApp({ quiet })`: `quiet() -> false` while the app knows of its own writes not acknowledged outside the
  queue (writes an older version left in the SDK's offline queue): the watchdog then never restarts the connection
  under them (it already waited for the queue's own saves).
- `app.facts() -> { persisted, confirmed, heardAt }`: the storage guard's answer, whether the server has answered
  since sign-in, and when it last did (ms), for an app's own status words (no second `persistGuard` call needed).
- `app.flush(ms)`: one wait of ms in all (it waited ms for saves being stored, then ms again for their sends), and
  false while a save is still being stored (it said true then: nothing was in the queue yet).
- Documented, unchanged: the hub reads by `backend.stampMode` unless `hub.stampMode` is given (an app whose server
  stamps are not on every record yet passes `hub: { stampMode: 'client' }`).

## 0.7.2 (2026-10-25)

Fix (#19): a save shows in the lists (`watchSaved`, `queue.overlay`) from the moment `save()` is called. Before, it
showed only once it was stored and accepted (sent, or 180 ms), so a list handed in that window had the old value, and
a change worked out from it (the next place's order) used the old value. Now the queue keeps the save in memory
until its job is stored, and lays over pending jobs that are not accepted yet; a save refused at once (storage
unavailable, account changed) leaves the lists again. Apps that kept their own map of unfinished saves for this can
drop it. Tests: `test/fixes.test.mjs` (+1, failing before the fix); model seeds unchanged.

## 0.7.1 (2026-10-25)

Held conflicts for merge collections, opt-in, and a fix to held answers. Nothing changes for an app without `held`,
nor for a merge collection that `held` doesn't name (`held: true` still leaves merge collections last-write-wins).
Tests: `test/held.test.mjs` (+4), the model test run a third time with the merge collection held, emulator.

- Held for a merge collection: name it in `held` (`held: { items: true }` with `merge: { items: fn }`). The merge
  function still applies the save's ops (patches, nested increments) to the server's copy inside the transaction; the
  save is held only where that would overwrite a change made elsewhere: a path changed on both sides to different
  values where the merge takes this device's value. Increments the merge adds up never clash; stamps, `mark` and
  `edits` are never compared. Writes `edits` (who changed each top-level field) and the held error carries `remote`
  (also when the merge function itself refuses). Deletes and edits of a record deleted elsewhere are held as with
  whole records. The merge function must be pure (it also runs on base), and the app passes the copy the edit
  started from as base (null: every field sent counts as changed). `describe()` and `resolve()` go through the merge
  function: the answer is the merge of this device's ops with the server's copy, theirs where chosen, saved over
  that copy (held again if it changed meanwhile, never a blind put). New pure helpers `mergeClashes`, `mergeFnClashes`.
- Fix (held, 0.6.3+): a save queued behind one that is then held (made offline, before the clash was known) is now
  part of "mine" in `describe()` and `resolve()`. Before, answering set it aside in the history (with the "kept"
  notice) and its change never reached the server. The queue also keeps a replaced held copy's ops.
- Release: a new tag now starts the Deploy workflow, so the new version is served on core at once (0.6.4 and 0.7.0
  were served only after the next push: the push's own deploy ran before the tag existed).

## 0.7.0 (2026-10-25)

Types only: JSDoc across `src/` and `index.js`, checked by `tsc --checkJs` in Checks. No runtime behaviour change
(the same 219 unit tests, the model test with its seeds and the emulator tests pass unchanged).

- `src/types.js`: the shared shapes (`Doc`, `Snapshot`, `Job`, `Outbox`, `QueueOptions`, `Store`, `ConflictView`, ...).
  Types only; nothing imports it at run time, so the file adds no load. Editors read the types from the published
  files with no build step (`// @ts-check` in an app, or `import('.../types.js').Doc` in its JSDoc).
- Every export of the public API and the internal helpers has `@param` / `@returns` types, and the option objects of
  `createApp`, `createSyncHub`, `createCollectionSync`, `createTombFeed`, `createWriteQueue`, `createStores`,
  `createFirestoreBackend`, `createReport`, `forgetDevice` and `firestoreCache` are typedefs.
- `tsconfig.json` (`allowJs`, `checkJs`, `noEmit`, `noImplicitAny`) and `npm run typecheck`; Checks runs it as a step
  of the `unit` job (TypeScript 5.8.3, not saved in package.json's run-time path).

## 0.6.4 (2026-10-25)

Additive: nothing changes for an app that doesn't call the new helper. Tests: `test/cache.test.mjs` (47, with seeds).

- `src/cache.js firestoreCache(F, { app, settings, report, storage })`: the SDK's offline cache for this device,
  multi-tab first, stepping down to one tab and then memory on the quota or "Unexpected state" error, remembered per
  device, with report codes `cache-quota`, `cache-state`, `cache-single`, `cache-memory`. Also `cacheFailure`.
- README: what the listener watchdog covers (silent stalls) and does not (SDK #8696, #8305).

## 0.6.3 (2026-10-25)

Held conflicts by field, opt-in (`backend: { held }`); nothing changes for an app that doesn't set it. Tests:
`test/held.test.mjs`, the model test run again with held conflicts (`test/model.test.mjs`), Worker report test.

- `conflict.js mergeHeld`: a 3-way merge per field. Different fields merge; the same field changed to the same value
  is no conflict; counters (`held: { coll: { counters: [...] } }`, need `mark`) add each side's change; a field
  changed on both sides to different values throws `write-conflict` with `fields` (the clashing paths) and nothing is
  written. Also `clashingFields`, `describeConflict` (the popup's data: both versions side by side, when each changed
  in SGT and who, signed-in name and device), `resolvedRecord` (the answer, keeping this device's other changes) and
  `whenText`.
- Firestore adapter: `held` (true or per collection; `merge` collections stay as they are), `edits` (a field that
  records `{ by, device, at }` per changed top-level field: a data-shape change, so rules that whitelist fields must
  allow it) and `editor()`. A delete meeting a change elsewhere, or an edit of a record deleted elsewhere, is held too.
- `createApp`: `device` (the device's name), and `conflicts()`, `describe(key)`, `resolve(key, choice)`. A held save
  exists only on the phone that sent it second, so only that phone answers; `status$` stays on attention until it does.
- Write queue: `ignore` (fields left out when comparing versions; createApp passes the engine's fields with `held`).
- Report: `createReport({ byKind: true })` adds `held: { kind: n }` when there are conflicts; the Worker accepts and
  stores it (new D1 table `held`, the day's highest per kind) and the digest lists conflicts by kind.

Two engine fixes, for every app (plain and held; both found by the held model test at 300 seeds; tests in
`test/fixes.test.mjs`):

- A delete heard while a save of that record is held (its bin or feed entry arrives while the record has unsent
  saves) is now remembered (`meta.later`) and applied once the record's saves are done (`hub.settle(scope)`, which
  createApp calls on every queue change; also when the collection next opens). Before, the tombstone was forgotten:
  after the answer "theirs" (the deleted version) the stale record showed until the weekly full read.
- A record deleted elsewhere and saved again here ("keep mine", a restore) is stamped after the delete's tombstone
  known on this device (`hub.tomb(scope, coll, id)`, passed to the adapter as `commit(..., { after })`). Before, a
  clock behind the deleter's stamped it at or below that tombstone, and devices holding the tombstone did not show it
  until their weekly full read. Only records not on the server are affected; an update still stamps from the
  server's copy.

## 0.6.2 (2026-10-25)

- `createApp({ popupOnly: true })`: sign in with the popup only, never a redirect (not when the popup is blocked, nor
  in an installed app), for a page served from another domain than its auth domain, where a redirect sign-in can't
  finish. A blocked popup throws to the caller (ask for a tap). Default unchanged. Test: `test/app.test.mjs`.

## 0.6.1 (2026-10-25)

Model-based multi-device tests, and the bug they found. Nothing else changes for 0.6.0 callers.

- New `test/model.test.mjs`: for each seed, a random run of saves, deletes, going offline and back, wakes and reloads
  on two or three devices (`createApp`, the real Firestore adapter on a fake SDK, clocks minutes apart), then checked
  against a simple model: every device shows the server's records (except one held for the user), each device's last
  value of its own field in a merge collection is on the server, and nothing is left waiting. 40 seeds in the unit
  run (about 10 s); `MODEL_SEEDS=500` for more, `MODEL_SEED=<n>` replays one (a failure prints its seed and steps).
  The fake SDK moved to `test/fake-sdk.mjs` (shared with `test/faults.test.mjs`).
- Fixed (`createApp`): a record deleted on this device could keep showing in its list until the weekly full read. The
  delete's bin entry arrived while the delete was still being sent, when the engine keeps a record with unsent saves,
  and a delta listener never hears an older record go. Once this page's delete is done (and is still the record's
  latest save), the record leaves the device copy (`hub.drop`). Apps wired by hand can do the same. Test:
  `test/app.test.mjs` (failed before).
- Not explained by this: the stale `done` field on a removed list line in one app's multi-device tests (0.6.0 notes).

## 0.6.0 (2026-10-25)

`createApp`, the one call that wires the safe path, so an app's cloud module becomes config. Adds only: every 0.5.1
call and module works as before. Tests: `test/app.test.mjs` (written first, failed before) and
`test/app.emulator.mjs` (Auth + Firestore emulators: sign in, save offline, sync, sign out and wipe).

- `createApp({ name, colls, path, sdk, … })` (`src/app.js`): Google sign-in (popup, redirect when the popup is blocked
  or the app is installed; a redirect is finished on load), the account as `{ uid, email, name, photo, verified }`,
  the storage guard at sign-in, a claims refresh (`claims: { url, entry }`: asked once per uid and role version, then
  the token is refreshed), the device copy, the outbox (named in the origin-wide list by default) and the queue, the
  hub with `replanOnWake` and the unsent-records hook, the watchdog, `status$` (never synced before the server has
  answered once), one save at a time per record, `onRefused` for saves the server refused, and `signOut` (refuses
  while anything is unsent, stops if someone else signed in meanwhile, then `forgetDevice` and the SDK's sign-out).
- Escape hatches, not flags: `adapter`, `commit` (an app's own transactions), `outbox`, and the `backend`, `hub`,
  `stores`, `queue` option objects are passed through; `parts` hands back the hub, queue, stores, adapter, watchdog
  and registry. `userOf` and `claimsBehind` are exported for apps that keep their own sign-in.
- Fixed (from the unreleased 0.5.2 branch, folded in): a device could keep showing its own save's copy of a record,
  without a change another device made to it at the same moment, until the record changed again (in an app's two- and
  three-device tests, about 1 run in 12). The listener heard the server's copy (both changes) while the save was still
  being sent, so the save's copy was laid over it; when the save was done only the queue changed, and the pattern the
  README showed (`queue.overlay` inside `hub.watch`) lays it over again only when the listener sends a list. New
  `watchSaved({ hub, queue, scope, coll, kind }, cb)` (`src/writes.js`) does both: the list with the device's saves
  over it, again when either changes. `createApp`'s `watch` uses it. Tests: `test/fixes.test.mjs` and the emulator
  test (two devices on one record).
- Fixed: the nothing-lost report sent twice on page hide (browsers fire `visibilitychange` and `pagehide` together),
  counting each error twice. One `flush` at a time: one asked while another is being sent gets that one's answer.
  Test: `test/report.test.mjs`.
- Known, not traced yet: in one app's multi-device tests a removed list line's `done` field still shows stale about
  once in 60 runs; it is not explained by the case above.
- Emulator script now starts the Auth emulator too (`firebase.json`, `test:emulator`).

## 0.5.1 (2026-10-25)

Two adapter calls, so apps stop reaching past the adapter for them. Nothing changes for 0.5.0 callers. Tests:
`test/create.test.mjs` (failed before) and the emulator test.

- Adapter `create(scope, coll, record)`: a new record written without a read inside the transaction, for rules that
  can't answer a read of a document that isn't there yet. A copy already on the server (an earlier send whose answer
  was lost) is returned and nothing is written; a refused read counts as not there; a write refused with
  `permission-denied` looks again and returns the copy if that earlier send landed. Stamped as `commit` stamps
  (`serverAt` too in server mode); offline it throws `unavailable`, so the queue keeps the save.
- Adapter `existing(scope, coll, ids)`: the ids the server has, 30 a query and four queries at once, from the server
  only (throws offline), reads counted as billed. For a restore that adds only what is missing.

## 0.5.0 (2026-10-25)

Nothing-lost report, opt-in. Nothing changes for callers that leave `report` out. Tests: `test/report.test.mjs`
(nothing from a record, its id, path, email or an error message can get into a report) and
`worker/test/report.test.mjs` (the endpoint).

- `createReport({ app, version, … })` (`src/report.js`; from `index.js` with this engine's version filled in): at most
  once an hour, and when the page is hidden, sends `{ v: 1, app, version, sync, unconfirmed, refused, conflicts,
  errors }` to `core.anawj.com/report`: saves still waiting for the server after an hour, saves the server refused,
  saves that met a change made elsewhere, and sync errors by code since the last report. Counts, short error codes and
  versions only. `buildReport` is the pure part.
- Write queue `report`: counts the queue's saves and each failed send by its error code (`outbox-write` when the
  outbox could not be written). A report that throws never stops a save.
- Worker: `POST /report` (our sites only, 2 KB, 20 a ten minutes per address) keeps per-app daily counts in D1;
  `GET /report/digest` (token) gives the day's digest for the owner's daily message.

## 0.4.2 (2026-10-25)

Several apps on one origin. Nothing changes for 0.4.1 callers that leave the new options out, except the fix below.
Each change has a test in `test/origin.test.mjs` that failed before it.

- Fixed: `clearCache` (adapter) gives up after `timeout` ms (default 3000) with `{ code: 'deadline-exceeded' }`, and
  `forgetDevice` counts `clearBackendCache` as failed after its `timeout` (default 3000): clearing the SDK's cache
  waits while another tab of the origin uses it, so sign-out never reached `extra` or the reload.
- `createOutboxRegistry({ storage, open, timeout })` (`src/registry.js`): the origin's list of outboxes, kept in
  localStorage. A write queue given `registry` refuses sign-out (`flush`) while any registered outbox has unsent
  saves for this user (unreadable or no answer counts as unsent), and `forget` forgets this user in all of them.
  Opt-in: apps that don't register, and queues without `registry`, work as before.
- `createOutbox` returns its `name` and `realm` (the registry's key).
- Adapter `writeId: false`: the id stays the document's id only, not a field (rules whose field whitelist has no
  `id`). Default as before.
- Adapter `onCommit` is also given the save's `key` and `ops` (an audit entry from the save, stored under its key).
- Docs and test: a merge function refuses a change it can't apply by throwing `{ code: 'write-conflict', remote }`;
  the save ends as a conflict for the user (discard or try again), not as failed, which would keep sign-out shut.

## 0.4.1 (2026-10-25)

Fault-injection tests (`test/faults.test.mjs`): the network dropping and coming back mid-queue, two devices writing one
record (clocks apart, lost transaction races), sign-out with saves not sent, data left by 0.3.0 clients, Firestore's
transient errors, a record leaving the query with unsent saves, and the update module's reload with a draft open.

- Fixed: a record with unsent saves whose bin or leave-feed entry arrives (deleted, locked or moved elsewhere) stays
  on this device and `onLeave` reports it, as 0.4.0 already did when the query dropped it; it was removed, so the
  save's conflict had no record to show against. Also for a collection nobody watches at that moment.
- Docs: after `forgetDevice` says no (`proceed` false), the hub is stopped; the app watches again.

## 0.4.0 (2026-10-25)

Safety pack. Nothing changes for 0.3.0 callers that leave the new options out, except the fixes marked below. Each
change has a test in `test/safety.test.mjs` that failed before it (the adapter's also in `test/firestore.emulator.mjs`).

- Fixed: the adapter's default stamp is `max(now, the server copy's stamp + 1)`, taken inside the commit transaction
  (plain and merge commits, numbers and ISO strings), so a writer whose clock is behind the last writer's still moves
  the stamp forward and delta readers see the change. An adapter given its own `stamp` function is unchanged.
  `stamp(prev)` and `stampFields(prev)` give the same rule for an app's own writes (no argument: now, as before).
- Fixed: `leaveEntry(kind, record, at)` stamps `deletedAt` as `max(at, record.updatedAt + 1)`, in the type of `at`,
  so an entry is always after the version it removes (0.3.0 gave `at` as it was, also when equal).
- Fixed: the write queue treats Firestore `aborted` (another device's transaction on the same record won) as
  transient: the save stays pending and is retried, instead of failing and needing the user.
- Adapter `onCommit({ scope, coll, before, after, at, fields })`: more writes (`{ path, data, merge }` or
  `{ path, delete: true }`) in the same transaction as a record's write, e.g. a leave entry with a lock.
- Adapter `clearCache()`: terminates the SDK and clears its offline cache (sign-out on a shared device).
- `syncStatus({ confirmed })`: false gives the new state `unknown` instead of `synced` until the server has
  answered once; `atRiskOnlyOffline: true` says `at-risk` only while offline.
- Write queue `otherPending: async () => bool`: writes sent outside the queue keep the sign-out check (`flush`) shut
  (a throw too); `queue.unsent(kind, id)` says a record has saves not sent yet.
- Hub and collection `unsent` and `onLeave`: a record that leaves the query (delta removal, a full read without it,
  or a check that finds it gone) while it has unsent saves stays on this device and is reported, instead of dropped.
- `forgetDevice({ hub, stores, queue, proceed, keep, clearBackendCache, extra })` (`src/forget.js`): sign-out in one
  order: stop all, check `proceed` again, wipe the stores keeping `keep`, forget the outbox, clear the SDK cache,
  then the app's own; `{ wiped, failed }`.

## update 0.2.0 (2026-10-25)

The update module (`core.anawj.com/update/0.2.0/`), tag `update-v0.2.0`. Nothing changes for 0.1.0 callers that leave
the new options out, except the stamp tool fixes. Tests in `update/test/` (unit and real browser).

- `register({ canReload, beforeReload })`: the take-over reload waits while `canReload()` says no (someone typing,
  a sheet open, changes sending) and is tried again when the tab is hidden or shown, on `pagehide`, and on
  `retryUpdate()`; `beforeReload` runs just before the reload. A worker started with `waitForGo` gets its go
  (`update:go`) only when `canReload` allows. Updates are also checked when the browser comes back online.
- `forceLatest({ canReload })` refuses while `canReload` (given here, else to `register`) says no.
- sw-core `waitForGo: true`: no `skipWaiting` on install; the new version waits for a page's go.
- Fixed (`tools/stamp-versions.mjs`, copied by apps): only exact-version `core.anawj.com/<name>/<x.y.z>/` addresses
  count as pinned; any other cross-site `SHELL` entry gets a new hash every deploy, so a changed file under a moving
  address (`…/v1/`) reaches the phones. The date is the app folder's last git change in SGT (was today in UTC).

## 0.3.0 (2026-10-24)

Server stamps, as an option. Nothing changes for 0.2.0 callers that leave the new options out, except the fix below.
Each addition has a test in `test/server.test.mjs` (the adapter's in `test/firestore.emulator.mjs`).

- `stampMode: 'server'` (adapter, hub, collection, bin feed): every commit also sets `serverAt` (`serverField`) to
  the server's time, in the same transaction, beside the usual stamp; the delta read is `serverAt >` the newest
  server stamp this device has had confirmed (`planServer`, `meta.anchor`), with no SKEW and no local clock. So a
  write that reached the server late, a writer clock behind or a reader clock ahead no longer hides a change until
  the weekly full read. A stamp not yet resolved (this device's pending write) or a cached snapshot never moves the
  anchor; a held record without a server stamp makes opens read in full until a backfill stamps it. Reads give
  `serverAt` as ms; the conflict check leaves it out. `stampFields()` gives the stamps for an app's own writes.
- `feeds: { [coll]: kinds }` (hub): more tombstone feeds shaped like the bin, for records that leave a query without
  being deleted (locked, moved, access removed); `leaveEntry(kind, record, at)` builds the entry to write.
- Fixed: `replanOnWake` also checks hourly (`every`, `REPLAN_EVERY`) while the page is shown, so a page that stays
  visible for days still starts its weekly full read.

## 0.2.0 (2026-10-24)

For apps adopting the engine from whole-collection listeners and last-write-wins saves. Nothing changes for 0.1.0
callers that leave the new options out. Each addition has a test in `test/adopt.test.mjs` (the adapter's in
`test/firestore.emulator.mjs`).

- Stamps (`updatedAt`, `deletedAt`) may be ISO strings as well as numbers (`timeOf`); the adapter's `time: 'iso'`
  writes and queries them as ISO strings.
- `unstamped: 'full'` (hub or collection): read in full while any record held has no `updatedAt`, until a backfill
  has stamped them all.
- `expire: { [coll]: { field, after } }` (hub): a soft-deleted record leaves the device once its removal time is
  older than `after` (`expireDocs`), since its later deletion for good reaches no delta listener.
- Last-write-wins by field: the adapter's `merge: { [coll]: true | fn }` writes the server's copy with this change
  merged in (`mergeFields`: changed fields win, maps merged key by key), never a conflict; a record deleted elsewhere
  fails as `not-found` instead of coming back. `mark` keeps the last save keys on the record so a save sent twice is
  applied once.
- `queue.save(kind, owner, record, base, { ops })` stores the change's ops and hands them, with the save's key, to
  `backend(owner, kind, record, base, { key, ops })`; a failed save replaced by a newer one passes its ops on.
- The adapter's `where(scope, coll)` filters every query of a collection; `stamp()` gives the stamp for now, for an
  app's writes outside the queue.

## 0.1.0 (2026-10-24)

First release: the sync engine, write queue, device stores, outbox, listener watchdog, status rules, storage guard
and Firestore adapter as brand-neutral ES modules, with the backend injected.

Fixed compared with the code it was taken from (each with a test in `test/fixes.test.mjs`):

- The bin feed now remembers the newest `deletedAt` it has seen and reads from there, so a device whose clock was
  fast at its last sync still receives tombstones stamped since.
- A page left open longer than the full-read interval now reads in full when it wakes (`hub.replan()`,
  `replanOnWake`), instead of keeping one ever-growing delta query.
- The sign-out check (`queue.flush()`) now fails closed when the shared outbox cannot be read.
- A backend call that never settles now times out (`sendTimeout`, 30 s) and is retried, instead of holding that
  record's saves until reload.
- Tombstones written to a collection's store while its engine is starting are no longer lost from its meta.

New: `createWatchdog` (with `decide`), `syncStatus` (`attention`, `at-risk`, `offline`, `saving`, `stale`,
`synced`), `persistGuard`, configurable store prefix, realm, bin collection and kinds.

Known limits: timestamps come from the writers' clocks. A writer more than 10 minutes behind, or a reader whose clock
stays more than 10 minutes ahead, can miss a change until the weekly full read; a record deleted without a bin entry
stays on a closed device until then. A server-timestamp mode is planned.
