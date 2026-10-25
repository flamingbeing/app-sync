# Moving to 1.0: from the one-object createApp to the modules

1.0.0-rc.1 removes `createApp(options)` from `index.js` and the `src/internal.js` names `index.js` used to re-export.
The stored formats do not change ([FORMATS.md](FORMATS.md)): a phone that ran 0.6-0.9 keeps its device copy and its
unsent saves, and sends them after the move. An app pinned to 0.x keeps working until it moves (tags never change).

## The steps, for every app

1. **Pins: one version.** Load the entries from `https://core.anawj.com/sync/1.0.0-rc.1/` (`app.js`, `auth.js`,
   `sync.js`, `update.js`; an import map with `@core/app`, `@core/auth`, `@core/sync`, `@core/update` is the
   recommended way) and the update core from `https://core.anawj.com/update/1.0.0-rc.1/` (`sw-core.js`,
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
   `1.0.0-rc.1`.

## Per app (from each app's code, 25 Oct 2026; one migration PR per app)

| App | Pins now (sync / update) | Old options to split | Sign-out today | Notes |
|---|---|---|---|---|
| pantry | 0.6.3 / 0.2.0 | `backend` (server stamps, merge), `stores.metaOnly`, `hub` (`bin: null`, `unstamped`, `expire`, `stampMode: 'client'`), `report`, `commit`, `onRefused`, `redirectFirst` | `app.signOut()` (wipes) | also `createReport`, `syncStatus`, `persistGuard` (unchanged) |
| kakihome | 0.7.3 / 0.2.0 | `device`, `backend` (`held`, `edits`, `merge`, `onCommit`), `stores.metaOnly`, `hub` (`unstamped`, `bin`), `queue.otherPending`, `onRefused`, `redirectFirst` | `app.signOut()` (wipes) | `leaveEntry` from `@core/sync` |
| rosters (three apps, one shared `docsync`) | 0.6.3 / 0.2.0 | `commit`, `adapter` (no-op listen), `scope`, `nav`, `queue` (`labels`, `delay`), `claims` (`url`, `when`, `behind`, `entry`), `forget.extra` | `app.signOut()` | pins also in each app's test helpers; `recordSignature` unchanged |
| apmes logbook | 0.7.3 / 0.2.0 | `kinds`, `outbox`, `commit`, `watchEvery: 0`, `backend` (`held`, `edits`), `stores` (`prefix`, `realm`), `queue`, `storage` | own (hub, watchdog, `forgetDevice` wired separately) | its sync test imports internal names from `index.js` (step 5) |
| apmes evals | 0.7.3 / 0.2.0 | `kinds`, `commit`, `watchEvery: 0`, `queue` (`otherPending`, `labels`) | `app.signOut({ wait })`, then the origin's outboxes on force | shared ward devices: `app.auth.forget({ force })` |
| apmes ccc | 0.7.3 / 0.2.0 | `commit`, `outbox`, `watchEvery: 0`, `nav`, `storage`, `queue` (`online`, `labels`, `registry`) | none (sign-in is evals'); `flush`, `forgetDevice` | may need only `sync` with the auth module of its host page, or the queue parts directly |
| prewarm | 0.6.3 / 0.2.0 | `kinds`, `scope`, `report`, `watchEvery`, `backend` (server stamps, `where`, `merge`, `onCommit`), `stores`, `outbox`, `hub` (`bin: null`, `feeds`, `unstamped`, `onLeave`, `onError`) | own `forgetDevice` on `app.parts` | its own sign-in methods stay app-side until the 1.x sign-in methods ([SHAPES.md](SHAPES.md)) |
| residencyapps | 0.6.3 / 0.2.0 | `nav`, `outbox`, `storage`, `watchEvery: 0`, `backend` (merge, `stamp`, server stamps), `queue.otherPending` | `queue.flush()` then `forgetDevice` on `app.parts` | `forget({ before })` can carry its own step |

The consumer matrix (Checks) runs each app's own tests on this engine in place of its pin: until an app has moved,
its row is red on 1.0 by design (report only); the app-starter row blocks.
