# Shapes for 1.x (the shape check, 0.9.2)

1.0 freezes names and stored formats ([README](README.md) "Stability", [FORMATS.md](FORMATS.md)); 1.x only adds. The
features below are **not built**. This page checks that each one can be added in a 1.x release without renaming,
removing or changing the meaning of anything 1.0 has, and without a stored-format change beyond optional fields. The
names here are reserved: 1.0 uses none of them for anything else. Their types are in `src/types.js` (type only, no
code).

| # | Need | 1.x shape (reserved) | Why it adds without breaking 1.0 |
|---|---|---|---|
| 5 | Bulk import, save many | `app.sync.saveMany(kind, scope, records)` -> one result per record, as `save` gives | A new method. Each record becomes an ordinary job (same job format, same states); the queue already sends many jobs, so nothing stored changes. |
| 6 | Photos and files | a `files` module (`@core/files`, `needs: ['auth', 'sync']`): the file's metadata is a sync record (a collection the app names), the bytes go through an upload queue of its own | A new module and entry. Metadata rides the existing sync record and job formats; the upload queue is a new store under `ctx.storage('files')` (the module storage row of FORMATS.md: `<name>:files/...`) or a new IndexedDB database `<name>-files`, neither of which 1.0 reads. |
| 7 | Public read-only data, no sign-in | `sync({ public: ['news'] })`: those collections are read with no account, in scopes named `public:<name>` | A new option. Scope names starting `public:` are reserved (FORMATS.md); they never hold saves, so the sign-out check and a switch's wipe stay correct (wiping read-only data loses nothing). |
| 8 | Sign-in: Google, email link, password, passcode, anonymous | `auth({ methods: ['google', 'emailLink', 'password', 'passcode', 'anonymous'] })` and `signIn({ method, hint, email, password, code })` -> the same `{ ok, reason }` | `signIn` already takes `{ method }` (`'google'` only in 1.0); a new method is a new value, and new `reason` values are additive (an app treats an unknown one as not ok). An anonymous account linked to a real one keeps its uid, so the owner (`<name>:auth/owner`) and the device's data stay; no switch. |
| 9 | Large data: keep only recent records, or one part | `sync({ keep: { <coll>: { recent: days } \| { part: (record) => string } } })` | A new option. What the device keeps goes in optional `meta.keep` / `meta.fetchedBy` (FORMATS.md, reserved); dropping a record from the device is an eviction, never a delete (deletes are only tombstones), so older versions on the same data stay right. |
| 4+ | Watch with a query or a limit | `app.sync.watch(scope, coll, cb, { query, limit })` | A new optional fourth argument; `watch(scope, coll, cb)` keeps its meaning. A limited watch reads what the device copy holds (it narrows the view, never the stored copy). |

## Reserved names

- Entries and import-map names: `@core/app`, `@core/auth`, `@core/sync`, `@core/update` (1.0), and, reserved with
  nothing built: `@core/files`, `@core/ui`, `@core/theme`, `@core/settings`, `@core/sw` (the service worker core,
  `sw-core.js`), `@core/devkit` (test helpers).
- Module names: `app`, `auth`, `sync`, `update`, `files`, `ui`, `theme`, `settings`, `sw`, `devkit`.
- Options and methods: `auth({ methods })`, `signIn({ method, email, password, code })`, `sync({ public, keep })`,
  `sync.saveMany`, `watch(..., { query, limit })`.
- Stored: `meta.keep`, `meta.fetchedBy`, scope names `public:*`, `<name>:files/*`, `<name>-files`.

## The UI kit is not the engine

`@core/ui` (sync chip, sign-in sheet, conflict sheet, update prompt, refused list), `@core/theme` (CSS custom
properties, a per-device theme and layout switch) and `@core/settings` (per-device options, new ones off) are a
separate kit. **The UI reads only the modules' public APIs; the engine never knows the UI.** CSS loads with `<link>`,
never as a JS import. A UI piece is an app's choice; the engine works the same with none of them.
