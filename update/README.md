# app-update

One service worker core and one page module for the owner's web apps, so every app updates the same way: a new
version installs in the background, takes over at once, and the open page reloads once. Plain files, no build step,
no run-time dependencies. Served from `https://core.anawj.com/update/<x.y.z>/` (exact pin, immutable), tag
`update-vX.Y.Z`. Brand-neutral: nothing app-specific lives here.

## In an app

`sw.js` (in the app's folder):

```js
const VERSION = 'myapp-v1';                 // the deploy stamps it: myapp-2026-10-24-ab12cd34
const SHELL = ['./', 'app.js', 'style.css', 'https://core.anawj.com/update/0.1.0/register.js'];
const MANIFEST = {};                        // the deploy fills it: a hash per shell file
importScripts('https://core.anawj.com/update/0.1.0/sw-core.js');
AppUpdate.init({ app: 'myapp', version: VERSION, shell: SHELL, manifest: MANIFEST });
```

The page:

```html
<script type="module">
  import { register, version, versionLabel, forceLatest } from 'https://core.anawj.com/update/0.1.0/register.js';
  register({ app: 'myapp', sw: 'sw.js' });
  // settings / about:  (await versionLabel())  ->  "2026-10-24 (ab12cd34)"
  // "Get the latest version" button:  forceLatest()
</script>
```

Deploy build: `node tools/stamp-versions.mjs <folder>` (copy `update/tools/stamp-versions.mjs` into the app). In CI run
it with `--check`, which fails when a `SHELL` file does not exist (that would otherwise stop installs on the phones).

## What it does

- **Install is all or nothing.** Every `SHELL` file is downloaded fresh; one failure (or a redirected or opaque
  answer) means the new version is not installed, no half-filled cache is left, and the old version keeps running.
- **Only changed files are fetched.** The stamped `MANIFEST` has a hash per file; files whose hash matches the
  previous version's are copied from its cache. No manifest, or a partial one, means everything is fetched.
- **Instant take-over.** `skipWaiting` on install, `clients.claim()` on activate. The page reloads once when a worker
  takes over (not on the first install). A second take-over within 20 s does not reload again (no loop).
- **Update checks.** On every return to the tab (at most one per 30 s) and every 3 h while the page is open.
- **Pages from the folder.** Every navigation is answered with `./` from the cache (never `index.html`, which
  Cloudflare previews redirect). Page and shell files are cache-first. A navigation nothing has cached falls back to
  the app's `offline` page (a `SHELL` file) or a small built-in one.
- **Never cached:** paths starting `/__/` (Firebase auth) and `/cdn-cgi/` (Cloudflare Access), plus the app's `never`
  list; non-GET requests; range requests; other sites, except the versioned Firebase SDK
  (`www.gstatic.com/firebasejs/<version>/`) and the app's own `runtime` rules.
- **Caches.** The shell cache is named like `VERSION`. On activate only this app's `<app>-*` caches go (apps share an
  origin), never `<app>-rt-*` (runtime), anything in `keep`, or other apps'. Runtime caches keep only `ok` answers
  that are same-origin or from a pinned rule, never opaque ones.
- **No data touched.** `forceLatest()` checks the network first, then removes only this app's worker and caches and
  reloads. Nothing offline, no data, no sign-in.

## Options of `AppUpdate.init`

| Option | Meaning |
|---|---|
| `app`, `version` | Required. `version` must start with `app + '-'`. |
| `shell`, `manifest` | Files precached at install (`'./'` is the page); the stamped hashes. An `https://` entry is an exact-pin address (the page module, so it works offline); its hash is `pinned`. |
| `offline` | A `shell` file shown when a navigation has nothing cached. |
| `never` | More paths kept off the cache: strings (prefixes of the path), regular expressions, or `url => bool`. |
| `keep` | Cache names (array) or `name => bool` that activate must not delete (e.g. a share inbox under the app's prefix). |
| `runtime` | Rules for files cached on first use: `{ name, match, strategy, max, maxAge }`. `match` is a regular expression, a URL prefix, or `(url, request) => bool`; `strategy` is `'cache-first'` (default), `'network-first'` or `'stale-while-revalidate'`; `max` caps the entries (oldest go first; leave it out for no cap); `maxAge` is milliseconds. |
| `handle` | `event => Response \| Promise \| null`, called first for every request (any method), e.g. a share-target `POST`. Return nothing to carry on. |

## Releasing a version

1. Change the files under `update/`; set `update/VERSION` and `CORE_VERSION` in `sw-core.js` and `register.js`.
2. `node tools/build-update.mjs --lock` and commit `update.lock.json`.
3. Merge with Checks green: `release.yml` tags `update-vX.Y.Z`, and the deploy publishes it. A released version never
   changes; fixes go in a new version.

Tests: `node --test update/test/*.test.mjs` (fake worker world) and `node update/test/e2e.mjs` (real Chromium through
Playwright).
