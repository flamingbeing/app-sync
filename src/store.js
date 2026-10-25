// This device's own copy of a scope's collections (the sync engine, sync.js, keeps it in step with the server).
// One IndexedDB database per scope (an account, a group) and realm, "<prefix><realm><scope>", with an object store per
// collection and a meta record per collection:
//   meta { coll, syncAt, fullAt, epoch?, newest?, gone: { id: deletedAt } }
// Collections in metaOnly (a tombstone feed such as a recycle bin) keep only their meta record.
// Falls back to memory (kept for this page only) where IndexedDB is missing or refused: every start is then a full
// read. wipeStores deletes every store of this prefix and realm on the device, and tells other tabs.
//
// createStores({ prefix, colls, metaOnly = ['bin'], realm = '', realms = ['demo:'] }) -> { openStore, wipeStores, storeName }
//   realm: keeps two modes apart on one origin (e.g. 'demo:'); a wipe in one never touches the other. realms: the
//   other realms in use, so the default realm ('') can tell their stores from its own.

/**
 * @typedef {import('./types.js').Doc} Doc
 * @typedef {import('./types.js').CollMeta} CollMeta
 * @typedef {import('./types.js').Store} Store
 * @typedef {{ prefix: string, colls: string[], metaOnly?: string[], realm?: string, realms?: string[] }} StoresOptions
 * @typedef {{ put?: Doc[], del?: string[], meta?: CollMeta, replace?: boolean }} StoreOp
 */

/** @template T @param {T} v @returns {T} */
const copy = v => JSON.parse(JSON.stringify(v));
/** @template T @param {IDBRequest<T>} r @returns {Promise<T>} */
const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

// an open that never settles (some WebKit builds; an open queued behind a delete another tab blocks) gives up after this
export const OPEN_WAIT = 4000;

/** @param {StoresOptions} options */
export function createStores({ prefix, colls, metaOnly = ['bin'], realm = '', realms = ['demo:'] }) {
  if (!prefix || !Array.isArray(colls)) throw new Error('createStores needs a prefix and a list of collections');
  const COLLS = [...colls], META_ONLY = new Set(metaOnly);
  const REGISTRY = prefix + 'registry';   // localStorage: names opened here (indexedDB.databases() is not everywhere)
  /** @param {any} scope */
  const storeName = scope => prefix + realm + String(scope || '').trim().toLowerCase();
  /** @param {string} name */
  const ours = name => name.startsWith(prefix + realm) && (realm !== '' || !realms.some(r => r && name.startsWith(prefix + r)));
  /** @type {Map<string, { docs: Record<string, Map<string, Doc>>, meta: Record<string, CollMeta> }>} name -> { docs: { [coll]: Map }, meta: { [coll]: meta } } */
  const memory = new Map();
  /** @type {Set<Store>} */
  const handles = new Set();  // open handles in this tab (closed when another tab wipes)

  /** @param {string} name @returns {Store} */
  function memoryStore(name) {
    if (!memory.has(name)) memory.set(name, { docs: Object.fromEntries([...COLLS, ...META_ONLY].map(c => [c, new Map()])), meta: {} });
    const m = /** @type {NonNullable<ReturnType<typeof memory.get>>} */ (memory.get(name));
    return {
      name, kind: 'memory',
      get closed() { return memory.get(name) !== m; },
      /** @param {string} coll */
      async load(coll) { if (memory.get(name) !== m) return { docs: [], meta: {} }; return { docs: [...(m.docs[coll] || new Map()).values()].map(copy), meta: copy(m.meta[coll] || {}) }; },
      /** @param {string} coll @param {StoreOp} [op] */
      async write(coll, { put = [], del = [], meta, replace = false } = {}) {
        if (memory.get(name) !== m) return;   // wiped (sign-out): never bring it back
        const docs = m.docs[coll] ||= new Map();
        if (!META_ONLY.has(coll)) {
          if (replace) docs.clear();
          for (const id of del) docs.delete(id);
          for (const d of put) docs.set(d.id, copy(d));
        }
        if (meta) m.meta[coll] = copy(meta);
      },
      close() {},
    };
  }

  // version 1 has every object store; a database left without them (opened elsewhere without a version) is upgraded
  /** @param {string} name @param {number} [version] @returns {Promise<IDBDatabase>} */
  function openDb(name, version = 1) {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(name, version);
      r.onupgradeneeded = () => {
        for (const c of [...COLLS, 'meta']) if (!r.result.objectStoreNames.contains(c)) r.result.createObjectStore(c, { keyPath: c === 'meta' ? 'coll' : 'id' });
      };
      r.onsuccess = () => {
        const db = r.result;
        if ([...COLLS, 'meta'].every(c => db.objectStoreNames.contains(c))) return resolve(db);
        db.close();
        openDb(name, db.version + 1).then(resolve, reject);
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Local store blocked by another tab'));
    });
  }
  /** @param {string} name */
  function remember(name) {
    try { const l = JSON.parse(localStorage.getItem(REGISTRY) || '[]'); if (!l.includes(name)) localStorage.setItem(REGISTRY, JSON.stringify([...l, name])); } catch { /* storage blocked */ }
  }

  // The store for one scope. Never throws: a store that can't open (or doesn't open in time) is a memory store.
  /** @param {string} scope @param {number} [wait] @returns {Promise<Store>} */
  async function openStore(scope, wait = OPEN_WAIT) {
    const name = storeName(scope);
    if (typeof indexedDB === 'undefined') return memoryStore(name);
    /** @type {IDBDatabase} */
    let db;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const opening = openDb(name);
    try {
      db = await Promise.race([opening, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local store took too long to open')), wait); })]);
    } catch (e) {
      console.warn('Local store unavailable; using memory', e);
      opening.then(late => late.close(), () => {});   // (opened after all: let it go, this page uses memory now)
      return memoryStore(name);
    } finally { clearTimeout(timer); }
    remember(name);
    let dead = false;   // deleted (sign-out in another tab): forget everything, never recreate the database
    /** @type {Store} */
    const handle = {
      name, kind: 'idb',
      get closed() { return dead; },
      /** @param {string} coll */
      async load(coll) {
        if (dead) return { docs: [], meta: {} };
        const only = META_ONLY.has(coll);
        const tx = db.transaction(only ? ['meta'] : [coll, 'meta'], 'readonly');
        const [docs, meta] = await Promise.all([only ? [] : req(tx.objectStore(coll).getAll()), req(tx.objectStore('meta').get(coll))]);
        return { docs, meta: meta || {} };
      },
      // one transaction: replace (clear first), deletes, puts and the meta record
      /** @param {string} coll @param {StoreOp} [op] @returns {Promise<void>} */
      write(coll, { put = [], del = [], meta, replace = false } = {}) {
        if (dead) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const only = META_ONLY.has(coll);
          const tx = db.transaction(only ? ['meta'] : [coll, 'meta'], 'readwrite');
          if (!only) {
            const s = tx.objectStore(coll);
            if (replace) s.clear();
            for (const id of del) s.delete(id);
            for (const d of put) s.put(d);
          }
          if (meta) tx.objectStore('meta').put({ ...meta, coll });
          tx.oncomplete = () => resolve();
          tx.onerror = tx.onabort = () => reject(tx.error || new Error('Local store write failed'));
        });
      },
      close() { dead = true; handles.delete(handle); try { db.close(); } catch { /* closed */ } },
    };
    // another tab deletes the database (sign-out) or a newer version of the app upgrades it: let go at once
    db.onversionchange = () => handle.close();
    handles.add(handle);
    return handle;
  }

  /** @param {string[] | unknown} keep */
  function closeAll(keep) {
    const k = new Set(Array.isArray(keep) ? keep : []);
    for (const h of [...handles]) if (ours(h.name) && !k.has(h.name)) h.close();
  }

  /** @type {(BroadcastChannel & { unref?: () => void }) | null} */
  let channel = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(prefix);
      // (one channel for every realm: a message names its realm, and one realm's sign-out never closes another's stores)
      channel.onmessage = e => { if (e.data && e.data.wipe && (e.data.realm || '') === realm) closeAll(e.data.keep); };
      if (channel.unref) channel.unref();   // node (tests): don't keep the process alive
    }
  } catch { channel = null; }

  // Delete every scope's store on this device (this realm only), in this tab and the others: sign-out, account
  // switch, account deletion. keep: scopes whose stores stay (the one signed in now, which another tab may be using).
  // Resolves when the deletes are done (or can't be).
  /** @param {string | string[]} [keep] */
  async function wipeStores(keep = []) {
    const kept = (Array.isArray(keep) ? keep : [keep]).filter(Boolean).map(storeName);
    closeAll(kept);
    for (const name of [...memory.keys()]) if (ours(name) && !kept.includes(name)) memory.delete(name);
    try { channel && channel.postMessage({ wipe: true, realm, keep: kept }); } catch { /* closed */ }
    if (typeof indexedDB === 'undefined') return;
    const names = new Set();
    try { for (const n of JSON.parse(localStorage.getItem(REGISTRY) || '[]')) names.add(n); } catch { /* storage blocked */ }
    try { if (indexedDB.databases) for (const d of await indexedDB.databases()) if (d.name && d.name.startsWith(prefix)) names.add(d.name); } catch { /* not supported */ }
    const mine = [...names].filter(n => ours(n) && !kept.includes(n));
    await Promise.all(mine.map(n => new Promise((/** @type {(value?: any) => void} */ resolve) => {
      try {
        const r = indexedDB.deleteDatabase(n);
        r.onsuccess = r.onerror = () => resolve();
        r.onblocked = () => setTimeout(resolve, 1500);   // an old tab holds it open; it closes on versionchange
      } catch { resolve(); }
    })));
    try { localStorage.setItem(REGISTRY, JSON.stringify([...names].filter(n => !mine.includes(n)))); } catch { /* storage blocked */ }
  }

  return { openStore, wipeStores, storeName };
}
