# app-update

One service worker core and one page module for the owner's web apps, so every app updates the same way: a new
version installs in the background, takes over at once, and the open page reloads once. Plain files, no build step,
no run-time dependencies. Served from `https://core.anawj.com/update/<x.y.z>/` (exact pin, immutable). From 1.0.0-rc.1
it has the engine's version (one tag `vX.Y.Z` serves `/sync/<x.y.z>/` and `/update/<x.y.z>/`); 0.1.0 and 0.2.0 (tags
`update-vX.Y.Z`) stay served. Brand-neutral: nothing app-specific lives here.

## In an app

`sw.js` (in the app's folder):

```js
const VERSION = 'myapp-v1';                 // the deploy stamps it: myapp-2026-10-24-ab12cd34
const SHELL = ['./', 'app.js', 'style.css', 'https://core.anawj.com/update/1.0.0-rc.1/register.js'];
const MANIFEST = {};                        // the deploy fills it: a hash per shell file
importScripts('https://core.anawj.com/update/1.0.0-rc.1/sw-core.js');
AppUpdate.init({ app: 'myapp', version: VERSION, shell: SHELL, manifest: MANIFEST });
```

The page:

```html
<script type="module">
  import { register, version, versionLabel, forceLatest, retryUpdate } from 'https://core.anawj.com/update/1.0.0-rc.1/register.js';
  register({ app: 'myapp', sw: 'sw.js', canReload: () => !typing() && !sheetOpen() && !sending() });
  // settings / about:  (await versionLabel())  ->  "2026-10-24 (ab12cd34)"
  // "Get the latest version" button:  forceLatest()   (refused while canReload says no)
  // after a sheet closes or the last change is sent:  retryUpdate()
</script>
```

Deploy build: `node tools/stamp-versions.mjs <folder>` (copy `update/tools/stamp-versions.mjs` into the app). In CI run
it with `--check`, which fails when a `SHELL` file does not exist (that would otherwise stop installs on the phones).
The date in the stamp is the folder's last git change, in Singapore time (now, in Singapore time, outside git;
`--date` wins). Only an exact-version address `https://core.anawj.com/<name>/<x.y.z>/...` counts as `pinned`; any
other `https://` entry (e.g. a `v1/` folder on another site, which can change under the same address) gets a new
hash every deploy, so the phones fetch it again (and every deploy is a new version).

## What it does

- **Install is all or nothing.** Every `SHELL` file is downloaded fresh; one failure (or a redirected or opaque
  answer) means the new version is not installed, no half-filled cache is left, and the old version keeps running.
- **Only changed files are fetched.** The stamped `MANIFEST` has a hash per file; files whose hash matches the
  previous version's are copied from its cache. No manifest, or a partial one, means everything is fetched.
- **Instant take-over.** `skipWaiting` on install, `clients.claim()` on activate. The page reloads once when a worker
  takes over (not on the first install). A second take-over within 20 s does not reload again (no loop).
- **Never under someone's fingers (opt-in).** With `register({ canReload })` the take-over reload waits while
  `canReload()` gives false (or throws), and is tried again when the tab is hidden or shown, on `pagehide`, and on
  `retryUpdate()`. `beforeReload` is awaited just before the reload (a throw does not stop it). Add
  `waitForGo: true` in the worker as well, so a new version installs but stays waiting until the page sends
  `update:go`, which `register` does only when `canReload()` allows: the old page keeps running untouched meanwhile.
  Without `waitForGo` the new worker still takes over at once (only the reload waits).
- **Update checks.** On every return to the tab and on coming back online (at most one per 30 s), and every 3 h
  while the page is open.
- **Pages from the folder.** Every navigation is answered with `./` from the cache (never `index.html`, which
  Cloudflare previews redirect). Page and shell files are cache-first. A navigation nothing has cached falls back to
  the app's `offline` page (a `SHELL` file) or a small built-in one.
- **Never cached:** paths starting `/__/` (Firebase auth) and `/cdn-cgi/` (Cloudflare Access), plus the app's `never`
  list; non-GET requests; range requests; other sites, except the versioned Firebase SDK
  (`www.gstatic.com/firebasejs/<version>/`) and the app's own `runtime` rules.
- **Caches.** The shell cache is named like `VERSION`. On activate only this app's `<app>-*` caches go (apps share an
  origin), never `<app>-rt-*` (runtime), anything in `keep`, or other apps'. Runtime caches keep only `ok` answers
  that are same-origin or from a pinned rule, never opaque ones.
- **No data touched.** `forceLatest({ canReload })` is refused while `canReload` (given here, else the one given to
  `register`) says no ("Changes are still sending"), then checks the network, then removes only this app's worker and caches and
  reloads. Nothing offline, no data, no sign-in.

## Options of `register`

| Option | Meaning |
|---|---|
| `app`, `sw`, `scope`, `every` | The cache prefix, the worker's address, its scope, the timed check (3 h). |
| `canReload` | `() => bool \| Promise<bool>`: false while someone types, a sheet is open or changes are sending. The take-over reload, the `update:go` and `forceLatest` wait for it. |
| `beforeReload` | `() => void \| Promise`: awaited just before the take-over reload (e.g. save a draft). |

`retryUpdate()` tries an owed reload or go now (call it when the reason to wait has gone).

## Options of `AppUpdate.init`

| Option | Meaning |
|---|---|
| `app`, `version` | Required. `version` must start with `app + '-'`. |
| `shell`, `manifest` | Files precached at install (`'./'` is the page); the stamped hashes. An `https://` entry is an exact-pin address (the page module, so it works offline); its hash is `pinned`. |
| `offline` | A `shell` file shown when a navigation has nothing cached. |
| `never` | More paths kept off the cache: strings (prefixes of the path), regular expressions, or `url => bool`. |
| `keep` | Cache names (array) or `name => bool` that activate must not delete (e.g. a share inbox under the app's prefix). |
| `runtime` | Rules for files cached on first use: `{ name, match, strategy, max, maxAge }`. `match` is a regular expression, a URL prefix, or `(url, request) => bool`; `strategy` is `'cache-first'` (default), `'network-first'` or `'stale-while-revalidate'`; `max` caps the entries (oldest go first; leave it out for no cap); `maxAge` is milliseconds. |
| `waitForGo` | `true`: no `skipWaiting` on install; the new version waits until a page sends `{ type: 'update:go' }` (pair with `register({ canReload })`). Default: takes over at once. |
| `handle` | `event => Response \| Promise \| null`, called first for every request (any method), e.g. a share-target `POST`. Return nothing to carry on. |

## Releasing a version

1. Change the files under `update/`; set `CORE_VERSION` in `sw-core.js` and `register.js` to the engine's new version
   (the repo's release steps, AGENTS.md "Releasing").
2. `node tools/build-update.mjs --lock` and commit `update.lock.json`.
3. Merge with Checks green: `release.yml` tags `vX.Y.Z`, and the deploy publishes it. A released version never
   changes; fixes go in a new version.

Tests: `node --test update/test/*.test.mjs` (fake worker world) and `node update/test/e2e.mjs` (real Chromium through
Playwright).
