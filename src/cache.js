// The Firestore SDK's offline cache, chosen for this device: shared by every tab if the browser allows it, one tab
// if not, memory only as the last step. A device that failed once stays on the lower step (remembered, so the next
// load doesn't hit the same wall); the problem goes in the nothing-lost report as a short code.
//
// firestoreCache(F, { app, settings, report, storage, key }) -> { db?, cache, mode, failed(err), reset() }
//   F: the modular SDK's namespace ({ initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
//   persistentSingleTabManager, memoryLocalCache }). app: a Firebase app; with it the helper also calls
//   initializeFirestore(app, { ...settings, localCache }) and returns db, else use `cache` as `localCache` yourself.
//   report: a createReport() (its error(code) is called); storage: where the step is remembered (default
//   localStorage; wrapped in try/catch: without it nothing is remembered).
//   mode: 'multi' | 'single' | 'memory'. failed(err): call it with an error the SDK threw or a listener's error
//   callback got; if it is the quota or the "Unexpected state" kind it steps down, remembers, reports and returns
//   { changed: true, mode, code }: reload the page to start on the new step (the SDK can't switch caches on a live
//   db). Any other error returns { changed: false }. reset() forgets the remembered step (try multi-tab again).
//
// Report codes: 'cache-quota', 'cache-state' (what failed), 'cache-single', 'cache-memory' (the step this load runs
// on, when below multi-tab). Not covered: a cache in memory keeps nothing offline between loads (saves still wait
// in the outbox, which is separate).

export const CACHE_KEY = 'app-sync-cache';
export const CACHE_MODES = ['multi', 'single', 'memory'];

// 'quota' (storage full), 'state' (the SDK's "Unexpected state" assertion, usually a second tab on another
// instance of the cache), or null for anything else
export function cacheFailure(err) {
  if (!err) return null;
  const text = `${err.name || ''} ${err.code || ''} ${err.message || ''}`;
  if (/QuotaExceeded|quota|resource-exhausted/i.test(text)) return 'quota';
  if (/Unexpected state/i.test(text)) return 'state';
  return null;
}

const wrap = storage => {
  let s = storage;
  if (s === undefined) { try { s = typeof localStorage !== 'undefined' ? localStorage : null; } catch { s = null; } }
  return {
    get: key => { try { return s ? s.getItem(key) : null; } catch { return null; } },
    set: (key, v) => { try { if (s) s.setItem(key, v); } catch { /* nothing remembered */ } },
    del: key => { try { if (s) s.removeItem(key); } catch { /* nothing to forget */ } },
  };
};

const build = (F, mode) => mode === 'memory' ? F.memoryLocalCache()
  : F.persistentLocalCache({ tabManager: mode === 'multi' ? F.persistentMultipleTabManager() : F.persistentSingleTabManager({}) });

export function firestoreCache(F, { app = null, settings = {}, report = null, storage, key = CACHE_KEY } = {}) {
  const store = wrap(storage);
  const say = code => { try { report?.error?.(code); } catch { /* the report never breaks the app */ } };
  const saved = store.get(key);
  let from = Math.max(0, CACHE_MODES.indexOf(saved));
  let out = null;
  for (let i = from; i < CACHE_MODES.length; i++) {
    const mode = CACHE_MODES[i];
    try {
      const cache = build(F, mode);
      const db = app ? F.initializeFirestore(app, { ...settings, localCache: cache }) : undefined;
      out = { db, cache, mode };
      break;
    } catch (e) {
      // the last step (memory) can't fail this way; anything else the app must see
      if (i === CACHE_MODES.length - 1 || (app && !cacheFailure(e) && /already|different/i.test(e?.message || ''))) throw e;
      store.set(key, CACHE_MODES[i + 1]);
      say(`cache-${CACHE_MODES[i + 1]}`);
    }
  }
  if (out.mode !== 'multi' && out.mode === saved) say(`cache-${out.mode}`);
  const failed = err => {
    const kind = cacheFailure(err);
    if (!kind) return { changed: false, mode: out.mode, code: null };
    const code = `cache-${kind}`;
    say(code);
    const i = CACHE_MODES.indexOf(out.mode);
    if (i >= CACHE_MODES.length - 1) return { changed: false, mode: out.mode, code };
    store.set(key, CACHE_MODES[i + 1]);
    return { changed: true, mode: CACHE_MODES[i + 1], code };
  };
  return { ...out, failed, reset: () => store.del(key) };
}
