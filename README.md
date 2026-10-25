# app-sync

An offline-first sync engine for web apps, as plain ES modules with no dependencies. The backend is injected; a
Firestore adapter is included. Each tagged version is served unchanged at `https://core.anawj.com/sync/<x.y.z>/`, and an app pins an
exact version.

What it does:

- **Cheap opens.** Each collection has a copy on the device (IndexedDB, memory fallback). On open the copy shows at
  once, then the engine listens only for documents changed since the last sync (`updatedAt > lastSync - SKEW`),
  so opening with nothing changed costs about one read per collection. A full read runs the first time and weekly,
  and also when a page left open wakes after that week.
- **Deletes that travel.** Tombstones from a bin collection (or a deletion made on this device) remove a record
  everywhere, unless it changed after the deleted version.
- **Saves that are never lost.** Every save goes to a durable outbox first, then to the server one record at a time,
  in order. A save that fails or meets a change made elsewhere (a conflict) is kept until the user chooses; it never
  expires and never blocks a later save made on the version shown. Several tabs share the outbox safely.
- **An honest status.** A listener watchdog notices a stream that went quiet; the status rules say `synced` only
  when nothing is waiting, failed or in conflict and the server is being heard (with `confirmed`, `unknown` until the
  server has answered once).
- **Stamps only move forward.** The adapter stamps `max(now, the server copy + 1)` inside the commit transaction, so
  a writer whose clock is behind still moves a record's stamp on (0.4.0).
- **Sign-out keeps the device's data.** An accidental sign-out loses nothing: the device copy and unsent saves stay
  and send when the same account signs in again. The device is wiped only by `auth.forget()` or when a different
  account signs in; both are refused while anything is unsent (in any tab, another app on the origin, and the app's
  own writes through `track`), then `forgetDevice` stops everything, checks again, and deletes every store but the
  account kept, the outbox, the SDK's offline cache (`clearCache`) and the app's own lists.

## The modules (the 1.0 shape)

An app is a list of modules started by one runner: `createApp({ config, modules })` (`app.js`), with `auth`
(`auth.js`), `sync` (`sync.js`) and `update` (`update.js`). The one-object `createApp(options)` of 0.6-0.9 is removed in
1.0.0-rc.1; moving an app over: [MIGRATING.md](MIGRATING.md). The 1.0 promise: [CHANGELOG.md](CHANGELOG.md) (1.0.0-rc.1).

```js
import { createApp } from 'https://core.anawj.com/sync/1.0.0-rc.1/app.js';
import { auth } from 'https://core.anawj.com/sync/1.0.0-rc.1/auth.js';
import { sync } from 'https://core.anawj.com/sync/1.0.0-rc.1/sync.js';
import { update } from 'https://core.anawj.com/sync/1.0.0-rc.1/update.js';
import * as register from 'https://core.anawj.com/update/1.0.0-rc.1/register.js';

const app = createApp({ config: { name: 'myapp', sdk: async () => ({ A, F, auth, db }) }, modules: [
  auth(),
  sync({ colls: ['items'], path: (scope, coll) => ['spaces', scope, coll], scope: user => user.uid }),
  update({ register, app: 'myapp', canReload: () => !sheetOpen() }),
] });
await app.ready;
app.auth.onUser(user => show(user));
await app.auth.signIn({ hint: lastEmail });   // { ok, reason: '' | 'redirect' | 'unsent' | 'wipe' }
app.sync.watch(scope, 'items', list => draw(list));
await app.sync.save('item', scope, { id, text });
await app.auth.signOut();                     // keeps this device's data; the same account carries on
await app.auth.forget();                      // wipes this device (refused while anything is unsent, unless force)
await app.update.checkNow();                  // true once a new version took over
```

A module is `{ name, needs, start(ctx, deps) -> api, stop() }`: started in `needs` order, stopped in reverse; `deps`
holds only the apis it needs. `ctx` is small and frozen: `name, module, config, sdk(), user(), on(event, fn),
emit(event, data), storage(ns), status, report(fact), ready` (every module started). Events: `signin { user }`, `signout { user }` (data kept),
`switch { from, to }` (another account: the old data is wiped after `auth({ beforeSwitch })`), `forget { user, force }`.
Another account's sign-in is refused while the last one has unsent saves (also one made during `beforeSwitch`) or
when a module's wipe throws (the next sign-in tries again); `app.auth.blocked()` says which. Each tab switches its
own data, even after another tab switched first. `sync` has the sync api (open, watch,
watchDoc, save, flush, conflicts, status and the rest) and the same stored formats, so phones keep what they hold;
`scope(user)` opens the account's scope at each sign-in. `update` registers the service worker with register.js
(passed in) and holds the take-over reload while any module has unsent saves. Details: the comments at the top of
`src/runner.js`, `src/auth.js`, `src/module-sync.js` and `src/module-update.js`.

### Entries, the import map, types and Vite (0.9.2)

Each version serves four entries at `/sync/<x.y.z>/`: `app.js` (the runner), `auth.js`, `sync.js`, `update.js`,
plus `files.json` and the types under `types/` (`types/app.d.ts` and the rest, generated from the JSDoc). A page names
them once, in one import map; the version appears only there:

```html
<script type="importmap">
{ "imports": {
  "@core/app": "https://core.anawj.com/sync/1.0.0-rc.1/app.js",
  "@core/auth": "https://core.anawj.com/sync/1.0.0-rc.1/auth.js",
  "@core/sync": "https://core.anawj.com/sync/1.0.0-rc.1/sync.js",
  "@core/update": "https://core.anawj.com/sync/1.0.0-rc.1/update.js"
} }
</script>
```

The import-map names `@core/app`, `@core/auth`, `@core/sync` and `@core/update` are frozen. Reserved, nothing built
yet: `@core/files`, `@core/ui`, `@core/theme`, `@core/settings`, `@core/sw`, `@core/devkit` ([SHAPES.md](SHAPES.md)).
**The UI reads only the modules' public APIs; the engine never knows the UI.**

- **Modularity rules** (`node tools/modularity.mjs`, in Checks): importing an entry has no side effects (the SDK and
  storage load inside `start`), no top-level await, no entry imports another module's entry (shared code under
  `src/` is fine), only literal `new URL(x, import.meta.url)` and `import(x)`, and `.js` on every import.
- **Types:** `strict` JSDoc, TS-erasable style (`@typedef`, `@import`; no enums or namespaces), checked by
  `tsc -p .`. `npm run types` writes `types/`; Checks fail when it is stale. In a TypeScript or `checkJs` app, point
  the names at the version's types: `"paths": { "@core/*": ["<app-sync>/types/*.d.ts"] }`.
- **Package:** `package.json` `exports` has `.`, `./app`, `./auth`, `./sync`, `./update`, each with its `types`, so
  `npm install github:flamingbeing/app-sync#v0.9.4` works (no build step, nothing to run on install).
- **Vite** is never needed to run app-sync, and a page built with `vite build` works (Checks, `test/vite/`): (a) with
  `@core/*` and `https://` imports left external (the import map loads them), and (b) with `@core/*` bundled, from
  source or from the installed package, where a page that uses only `auth` and `sync` carries no `update` code. The
  bare `@core/*` names do not resolve in a bundler by themselves; one alias maps them to the package's exports:
  `resolve: { alias: [{ find: /^@core\/(app|auth|sync|update)$/, replacement: 'app-sync/$1' }] }`.

## Modules

`index.js` names the building blocks (everything below; the modules above are the way to wire them); each also loads
on its own (`src/<name>.js`).

| Module | Public |
|---|---|
| `src/user.js` | `userOf`, `claimsBehind` |
| `src/sync.js` | `createSyncHub`, `replanOnWake`, `leaveEntry`, `eachSettled`, `SKEW` |
| `src/writes.js` | `createWriteQueue`, `JOB_FORMAT`, `JOB_STATES` |
| `src/conflict.js` | `checkWrite`, `recordSignature`, `mergeFields`; held conflicts: `mergeHeld`, `describeConflict`, `resolvedRecord`, `pathOf` |
| `src/store.js` | `createStores` (the device copy: `openStore`, `wipeStores`) |
| `src/outbox.js`, `src/registry.js` | `createOutbox` (the write queue's durable store), `createOutboxRegistry`, `REGISTRY_KEY` |
| `src/watchdog.js` | `createWatchdog` |
| `src/cache.js` | `firestoreCache`, `cacheFailure`, `CACHE_KEY`, `CACHE_MODES` (multi-tab offline cache, steps down on quota or "Unexpected state") |
| `src/status.js` | `syncStatus`, `attentionCount` |
| `src/persist.js`, `src/forget.js` | `persistGuard`, `forgetDevice` |
| `src/firestore.js` | `createFirestoreBackend` |
| `src/report.js` | `createReport` (from `index.js`, version filled in), `REPORT_ENDPOINT` |
| `index.js` | the above, plus `FILES` and `VERSION` |
| `src/internal.js` | engine internals (`plan`, `applyChanges`, `createCollectionSync`, `decide`, `watchSaved`, tuning constants, …): no promise (from 1.0.0-rc.1 they no longer load from `index.js`). |

**Files of a version:** `FILES` (in `index.js`) and `sync/<x.y.z>/files.json` list every file the version loads,
for a service worker's offline list (0.8.0). `entries.json` (0.9.4) lists the files each entry (`app`, `auth`, `sync`, `update`) loads, so a page that uses only some entries can precache or vendor those alone.

## Use

The options of each module: `src/core.js` (sync), `src/auth.js`, `src/module-update.js`. The examples below use the
`app` from the code above.

```js
const app = createApp({ config: { name: 'myapp', sdk: async () => ({ A, F, auth, db }) }, modules: [
  auth({ claims: { url: '/api/claims', entry: user => roleDoc(user) } }),   // optional: role claims on the token
  sync({
    colls: ['items'], path: (space, coll) => ['spaces', space, coll],
    scope: user => user.email,                   // what to open at sign-in (or call app.sync.open(space) later)
    onRefused: (err, entry) => 'archive',        // optional: a save the server refused (else it waits for the user)
    forget: { extra: async () => clearAppLists() },   // optional: the app's own lists, wiped by a switch or forget()
  }),
] });

await app.ready;
await app.auth.signIn();
app.sync.status$(st => drawChip(st));            // { state, count }: synced only once the server has answered
const off = app.sync.watch(space, 'items', list => render(list));   // device copy, then the server; unsent saves laid over
await app.sync.save('items', space, { id: 'i1', text: 'Hello' }, previousCopy);   // base: the copy the edit started from

await app.auth.signOut();                        // keeps the device copy and unsent saves (same account: they send later)
const out = await app.auth.forget();             // { ok, reason: '' | 'unsent', failed }: wipes this device on purpose
```

### Writes outside the queue, and the sign-in/sign-out hooks (0.8.1)

```js
await app.sync.track(setDoc(ref, data), { kind: 'items', id });   // a write sent straight to the SDK: unsent until it settles
app.sync.unsentOutside();                             // their count, at once (0 when none)
app.sync.heard({ fromCache: snap.metadata.fromCache });   // a listener of the app's own heard: status and watchdog
const ready = app.sync.idle();                        // nothing stored, sent, queued or outside: an update's canReload
await app.auth.signIn({ hint: lastEmail });      // login_hint; also { popupOnly, redirectFirst } per call
await app.auth.forget({ before: async () => stopMyListeners(), force: userSaidLoseThem });
```

Tracked writes count everywhere the queue's saves do: the status, `flush`, the switch and forget() gate, `idle()` and the
watchdog. `before` runs before the wipe (forget()). `force` forgets unsent saves (only once
the person chose that). Promised from `queue` and `hub`: `queue.{ onChange, pending, status, error, unsent,
conflicted }` (0.8.2: and `refused`, `retry`, `discard`, `entries`, `finished`, `lastSent`) and `hub.drop`; the rest
of `parts` is an escape hatch with no promise.

### One document, reconnect, wake and the claims watch (0.8.3)

```js
const stop = app.sync.watchDoc(['households', hid], (h, meta) => h ? show(h) : leave());   // null: gone (server or listener failure)
await app.sync.reconnect({ why: 'Sync now' });          // the connection restarted (false offline or under an outside write)
sync({ ..., wake: true });                         // online, pageshow, shown again: the watchdog asks, saves are sent
auth({ claims: { url: '/api/claims', watch: true, doc: u => ['members', u.uid], onClaims: ({ asked, status }) => show(status) } });
```

`watchDoc` never says "gone" from the device copy alone (no signal, nothing cached); the watchdog restarts it like the
lists, and sign-out pauses it. The claims watch reads the role doc live and checks the token again whenever it changes.

### Refused saves, job data and the watch change info (0.8.2)

```js
app.sync.queue.refused();                              // saves the server refused, waiting for the person: [{ key, code, record, meta, … }]
await app.sync.queue.retry(key); await app.sync.queue.discard(key);   // send it again, or give it up
await app.sync.save('item', scope, rec, base, { meta: { row: 3 } });   // kept with the job, after a reload too
app.sync.queue.finished(key)?.meta;                    // the job once synced or set aside (null while it is not)
app.sync.watch(scope, 'items', (list, { changed, removed }) => redraw(changed, removed));
app.sync.copyOf('item', id);                           // the copy last handed to a watch, at once
const mine = app.sync.queue.lastSent('item', id), seen = app.sync.lastSeen('item', id);   // { stamp, signature }, after a reload too
```

A refused save keeps its error code on the job. `onRefused` returning `'archive'` sets it aside (state `archived`
with `refused: true`, so every version's sign-out gate counts it finished) and the engine keeps it out of the
history's pruning until the person retries or discards it, so an app needs no refused list of its own. Until then
a switch or forget() is refused (`forget({ force })` still wipes). `lastSent` is
the copy this device last sent (while it is in the device history, the last 100 finished saves) and `lastSeen` the
server's as last heard: when their signatures differ, someone else saved since.

Anything the facade does not cover: pass the parts' own options (`backend`, `hub`, `stores`, `queue`), replace a part
(`adapter`, `commit`, `outbox`), or use `app.sync.parts` (hub, queue, stores, adapter, watchdog, registry). Each module
also loads on its own; the full wiring by hand (0.5.x style) still works, and `src/app.sync.js` shows it in one place.
Each module's header comment describes its options and contract in full.

### Save many, a narrowed watch, a default merge and a commit retry (1.1.0)

```js
const results = await app.sync.saveMany('item', scope, records);   // one { status, value | reason } per record
app.sync.watch(scope, 'items', list => draw(list), { query: { done: false }, limit: 50 });
sync({ ..., backend: { merge: { '*': replaceRecord }, commitRetry: { codes: ['permission-denied'], delay: 500 } } });
```

`saveMany` saves each record as `save()` does (through the outbox, a conflict per record), each on the copy this
device shows as its base. A watch's `query` (fields equal to these values) and `limit` narrow what its callback gets,
never the device copy. `merge['*']` is the merge of every collection not named; `replaceRecord` (from `@core/sync` or
`index.js`) writes the save over the server's copy whole. `commitRetry` tries a commit refused with one of `codes`
once more after `delay` ms.

### A kind saved elsewhere, unstamped collections, the app's own listener, inStepAt and reopen (1.2.0)

```js
sync({ ..., kinds: { note: 'notes', shared: { coll: 'shared', path: (scope, coll, r) => ['groups', r.group, coll] } } });
sync({ ..., backend: { unstampedColls: ['settings'] }, reopen: async ({ memory, sdk }) => openFirestore(sdk, memory) });
app.sync.watch(scope, 'items', list => draw(list), { listen: myListen });
app.sync.facts().inStepAt;   // when the status was last synced; now while it is
```

A kind with `{ coll, path }` saves to `path(scope, coll, record)` instead of the scope's path, through the same queue.
`unstampedColls` writes those collections with the app's fields only (no `id`, stamp or server stamp; the conflict
check reads the content; read whole at every listen), for rules that refuse the extra fields. `listen` puts a collection on the app's own listener
(the adapter's `listen` shape), still kept in the device copy and watched by the watchdog. `reopen` hands every
module a new Firestore instance after a wipe (memory-only when the old cache could not be cleared), so a switch of
account needs no reload.

### Sign-in methods and public read (1.3.0)

```js
import { auth, emailLink, password, passcode, anonymous } from '@core/auth';   // name only those the page uses
auth({ methods: ['google', password(), anonymous()] });   // or SHAPES.md names: 'emailLink', 'passcode', ... (loaded when asked)
await app.auth.signIn({ method: 'password', email, password: secret });   // -> { ok, reason }
await app.auth.signIn({ method: 'emailLink', email });   // reason 'sent'; the page the link opens: the same call signs in
await app.auth.signIn({ method: 'passcode', code });   // passcode({ url }): POST { code, email? } -> { token }; else 'refused'
sync({ ..., colls: ['items', 'news'], public: ['news'] });
app.sync.watch('public:all', 'news', list => draw(list));   // no sign-in needed; read only
```

Each method is its own export, so a page bundles only those it names; a string name loads its file the first time
`signIn` asks for it (a passcode needs its `url`, so it is named with `passcode({ url })`). Signed in anonymously,
another method links its account to the anonymous one: the uid stays, so do the device's data and unsent saves (no
switch), and the owner gets the account's email. An account that exists already signs in instead (a switch, guarded
as any); a passcode's custom token always signs in. The engine keeps no email for an email link: the app keeps it.
`public` collections are read in scopes named `public:<name>` with or without an account: those watches run signed
out, are listened again at sign-in (under the account's rules), and carry on through a switch or `forget()` (their
copy is wiped with the rest: read only, it loses nothing). `open`, `save` and `saveMany` on a `public:` scope throw
"read only"; only the `public` collections can be watched there.

### Held conflicts by field (0.6.3, opt-in)

```js
sync({ …, device: 'Ward phone',
  backend: { held: true, edits: '_edits', mark: '_saves' } });   // or held: { items: { counters: ['qty'] } }
app.sync.status$(st => drawChip(st));                 // 'attention' while a held save is unanswered
for (const c of app.sync.conflicts()) {               // this phone's held saves only
  const d = app.sync.describe(c.key);                 // d.fields: [{ path, keys, mine, theirs }], each { value, when (SGT), by, device }
  await app.sync.resolve(c.key, await askUser(d));    // 'mine' | 'theirs' | { [path]: 'mine' | 'theirs' }
}
```

Two phones changing different fields of a record both keep their change; the same field changed to the same value
asks nothing; counters add up. Only a field changed on both sides to different values holds the save, on the phone
that sent it second and nowhere else (the server never has it, so no other phone has anything to answer), until the
user chooses; nothing is overwritten without that answer, and this phone's other changes land either way. `edits`
records who changed each field and when (`{ by, device, at }` per top-level field), a data-shape change: security
rules that whitelist fields must allow that field (and `mark`'s). `createReport({ byKind: true })` counts held saves
per kind in the report, so a kind that clashes often shows in the digest. Off by default: without `held`, every
collection keeps the whole-record check.

A merge collection (`merge: { items: fn }`, the merge function applying the save's ops) is held too when `held`
names it (0.7.1; `held: true` leaves merge collections last-write-wins): the merge function still applies ops such as
increments, which never clash; only a path changed on both sides to different values, where the merge would take this
phone's value over the other's, holds the save. Pass the copy the edit started from as base.

### The offline cache and what the watchdog covers (0.6.4)

```js
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager, memoryLocalCache } from 'firebase/firestore';
const F = { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, persistentSingleTabManager, memoryLocalCache };
const { db, mode, failed } = firestoreCache(F, { app: firebaseApp, report });   // mode: 'multi' | 'single' | 'memory'
// from a listener's error callback or a failed SDK call:
if (failed(err).changed) location.reload();      // the next load starts one step lower
```

Tabs share one offline cache (`multi`); if the SDK refuses it, or the storage is full, the device steps down to one
tab (`single`), then to memory only, and stays there (remembered on the device; `reset()` tries again). The step goes
in the report as `cache-quota` / `cache-state` (what failed) and `cache-single` / `cache-memory` (the step in use).
Memory only means nothing offline between loads; unsent saves still wait in the outbox, which is separate. Without
`app`, the helper returns just `cache` for your own `initializeFirestore`. Apps that don't call it keep their cache.

The listener watchdog covers a stream that goes **silent** (shows only the phone's copy for too long, a flag that
never clears, no word from the server after the phone comes back); it listens again, then restarts the connection.
It does **not** cover: an offline phone whose listener never calls back at all
([firebase-js-sdk#8696](https://github.com/firebase/firebase-js-sdk/issues/8696): the status then says `offline`, not
`synced`), nor a full browser storage quota ([#8305](https://github.com/firebase/firebase-js-sdk/issues/8305): use
`firestoreCache`'s step-down). Neither case shows `synced` without the server having been heard (see the status rules).

## What stays in each app

Schemas and the clean/canonical form of a record, collection names and paths, security rules, which collections need
conflict handling, the bin and history screens, and how the status looks.

## Server rules the engine relies on

- Every synced document carries a number field (default `updatedAt`) that only increases when it changes; in server
  mode also `serverAt`, set to `request.time` on every write (except `backend.unstampedColls`, 1.2.0).
- A bin entry is `{ id, kind, data, deletedAt }`, where `data` is the deleted version.
- Never `merge` an empty map, and never batch-overwrite records without reading them first.

## Tests

```
npm ci
node --test test/*.test.mjs   # unit tests, no network
npm run test:emulator          # the Firestore adapter on the local emulator (needs Java)
node tools/check.mjs           # repo checks
```

## Versions

Semantic versions, tagged `vX.Y.Z`; see [CHANGELOG.md](CHANGELOG.md). A tag is never moved or overwritten. Apps pin an
exact version and upgrade on purpose after their own tests; a breaking change is a new major version. Every fix
lands with a test that failed before it.

## Stability

- **API:** from 1.0, the module contract (`createApp({ config, modules })`, the module shape, `ctx`, the events), the
  entry names and import-map names, the `.d.ts` types and everything `index.js` names are kept until 2.0; 1.x only
  adds (CHANGELOG 1.0.0-rc.1 has the full list). A name deprecated in 1.x still
  works and is removed only in 2.0. `src/internal.js` carries no promise.
- **Stored formats:** [FORMATS.md](FORMATS.md), promised from 0.8.0 (mixed versions share data).
- **Core admission rule:** a new engine option or method goes in only if two or more apps (or the reference app)
  need it, or it is a correctness guarantee. Otherwise the app adapts with a thin adapter of its own (never a copy of
  engine code). Each addition lands with a reference-app or model test.
- **Size budget:** `tools/check.mjs` fails past a byte budget for `index.js` and `src/`; raising it is a CHANGELOG
  line.

## Licence

Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
