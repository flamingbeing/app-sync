# Stored formats (the format promise)

Phones on different app-sync versions share the same data: two apps on one origin read each other's outboxes, and a
phone on an old pin syncs the same documents as one on the newest. So what the engine **stores** is promised
separately from the API, from 0.8.0 on:

- **Until 2.0, nothing below changes or goes away.** A 1.x version may add an optional field that older versions
  ignore; it never renames a key, a prefix, a field or a state, and never adds a job state.
- A change that breaks this is a new major version (2.0) with its own migration, never a 1.x release.
- `test/freeze.test.mjs` pins these values and `test/formats.test.mjs` the sections below (0.9.2); a change there is
  a format change.

## On the device

| What | Format | Read by |
|---|---|---|
| Device copy | one IndexedDB database per scope and realm, named `<name>-sync:<realm><scope>` (createApp; `createStores({ prefix })` for your own), an object store per collection (key `id`) and a `meta` store (key `coll`): `{ coll, syncAt, fullAt, epoch?, newest?, gone: { id: deletedAt } }` | this app's tabs |
| Device copy list | localStorage `<prefix>registry` (the databases opened here); BroadcastChannel `<prefix>` for wipes | this app's tabs |
| Outbox | IndexedDB database `<name>-outbox` (createApp), version 1, store `changes` (key `key`, index `owner`); fallback localStorage `<outbox name>:<job key>` with the same job | every app on the origin (sign-out check) |
| Outbox list | localStorage `app-sync:outboxes` (`REGISTRY_KEY`): `[{ name, realm }]` | every app on the origin |
| Module storage (0.9.0) | localStorage `<name>:<module>[:<ns>]/<key>`, a JSON value (the runner's `ctx.storage(ns)`). The auth module keeps `<name>:auth/owner` = `{ uid, email }`: the account whose data this device holds (kept at sign-out, removed by `forget()`). The sync module (0.9.1) keeps `<name>:sync/scope` = the scope last opened, a string (so, signed out, its unsent saves are still counted, and a switch wipes that scope's outbox; removed by the wipe); its device copy and outbox are the ones above, same names | this app's tabs |
| Offline cache step | localStorage `app-sync-cache` (`CACHE_KEY`): `'multi'`, `'single'` or `'memory'` | this origin |

### Which scope holds a record (frozen at 0.9.2)

- A record in the device copy belongs to exactly one scope: the scope whose database holds it
  (`<name>-sync:<realm><scope>`, the scope trimmed and lower-cased). The same id in two scopes is two records. The
  scope is in the database name, never in the record: the engine stores the record as the server sent it.
- **A delete is only a tombstone:** an id in `meta.gone` on the device, a `_deleted` answer or a bin entry on the
  server. A record missing from the device copy without a `gone` entry is not deleted: it was never fetched, or it
  was dropped from the device (eviction). No version treats a missing record as a delete or sends one for it.
- Reserved for 1.x (optional, older versions ignore them; [SHAPES.md](SHAPES.md)): `meta.keep`
  `{ mode: 'recent' | 'part', since?, part? }`, what this device keeps of a collection, and `meta.fetchedBy`
  `{ [id]: part }`, which part fetched a record; scope names starting `public:` for data read without sign-in (read
  only, so wiping them at a switch loses nothing).

### A job (one save in the outbox)

`{ v, key, owner, kind, record, base, state, accepted, at, error?, result?, remote?, kept?, ops?, realm?, code?, refused?, meta? }`

- `v`: the job format, `JOB_FORMAT` = 1 on every job written from 0.8.0. A job without `v` was written before 0.8.0
  and has the same shape.
- `state`: one of `JOB_STATES`: `pending`, `synced`, `failed`, `conflict`, `archived`. **Finished** = `synced` or
  `archived`; every version's sign-out check treats any other state as unsent, so a new state would block sign-out
  in older apps on the origin forever. No new state before 2.0; new facts about a job go in new optional fields.
- 0.8.2 adds three optional fields (still `v: 1`; older versions ignore them): `code`, a refused save's error code;
  `refused: true` on an `archived` job set aside after the server refused it (a flag, not a state: every version
  counts it finished), kept out of pruning until retried or discarded and keeping 0.8.2's sign-out gate shut (an
  older version on the origin does not know the flag: its gate passes and it may prune the job once 100 newer
  finished saves pile up, as it always did); `meta`, the app's data about the save.
- `key`: `<owner>:<time base36>:<random>`; jobs of one record (`kind` + `record.id`) are sent oldest `at` first.

## On the server (Firestore adapter)

| Field | Meaning |
|---|---|
| `id` | the record's id, also written into the document (`writeId`, default on) |
| `updatedAt` (option `field`) | the stamp: only increases, `max(now, server copy + 1)` inside the commit transaction (ms, or ISO with `time: 'iso'`) |
| `serverAt` (option `serverField`) | `serverTimestamp()` on every commit in `stampMode: 'server'` |
| `_deleted` | `true` on a save or answer that deletes a record (the adapter deletes the document; others hear of it from the bin entry) |
| option `mark` (opt-in) | the keys of the last saves applied to a merged record (a resend is applied once) |
| `_edits` (option `edits`, opt-in) | `{ [field]: { by, device, at } }`, who changed each top-level field and when |
| bin entries | `{ id, kind, data, deletedAt }`, `data` the deleted version |
| leave entries (`leaveEntry`) | `{ id: '<kind>:<record id>', kind, data: { id, updatedAt }, deletedAt }`: only the record's id and stamp, no content |

The option names in brackets let an app pick another field name; whatever an app picks becomes its own stored
format and must not change without a migration.

## Files of a version (`files.json`, `entries.json`)

Published beside each version at `/sync/<x.y.z>/`, for a service worker's offline list or a vendoring step. Not stored
on a device or server; additive only.

- `files.json` (0.8.0): a JSON array, the files `index.js` loads (its import graph). Unchanged.
- `entries.json` (0.9.4): `{ "app": [...], "auth": [...], "sync": [...], "update": [...] }`, the files each entry loads,
  sorted, the entry file included. Paths are relative to the version's folder.
