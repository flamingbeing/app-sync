// The write queue's durable outbox on this device (writes.js): one IndexedDB database with a "changes" store indexed
// by owner, and a localStorage fallback when IndexedDB refuses. A completed transaction (or a successful fallback
// write) is required before an editor may discard its input.
//
// createOutbox({ name, realm = 'default' }) -> { name, realm, put, list, get, remove, forget }
//   name: the database name (also the localStorage key prefix). realm: keeps two modes apart on one origin.

/**
 * @typedef {import('./types.js').Job} Job
 * @typedef {import('./types.js').Outbox} Outbox
 */

/** @param {{ name: string, realm?: string }} options @returns {Outbox} */
export function createOutbox({ name, realm = 'default' }) {
  if (!name) throw new Error('createOutbox needs a name');
  const PREFIX = name + ':';
  /** @type {Promise<IDBDatabase> | null} */
  let opened = null;
  /** @returns {Promise<IDBDatabase>} */
  // opened once: unreadable is an error, not empty
  let everOpened = false;
  async function database() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('changes', { keyPath: 'key' });
        store.createIndex('owner', 'owner');
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close older tabs of this app to enable its local outbox'));
      request.onsuccess = () => {
        const db = request.result;
        everOpened = true;
        db.onversionchange = () => { db.close(); opened = null; };
        resolve(db);
      };
    }).catch(error => { opened = null; throw error; });
    return opened;
  }
  /**
   * @template T
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest<T> | void} operation
   * @returns {Promise<T>}
   */
  async function transaction(mode, operation) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('changes', mode), store = tx.objectStore('changes');
      /** @type {T} */
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Outbox write failed'));
      const request = operation(store);
      if (request) request.onsuccess = () => { result = request.result; };
    });
  }
  /** @param {string} owner @returns {Job[]} */
  const fallbackRecords = owner => Object.keys(localStorage).filter(k => k.startsWith(PREFIX))
    .map(k => { try { return JSON.parse(/** @type {string} */ (localStorage.getItem(k))); } catch { return null; } })
    .filter(x => x && x.owner === owner);
  return {
    name, realm,
    /** @param {Job} record */
    async put(record) {
      const copy = { ...JSON.parse(JSON.stringify(record)), realm };
      try {
        await transaction('readwrite', store => store.put(copy));
        try { localStorage.removeItem(PREFIX + copy.key); } catch { /* IndexedDB succeeded */ }
      }
      catch { localStorage.setItem(PREFIX + copy.key, JSON.stringify(copy)); }
      return copy;
    },
    /** @param {string} owner */
    async list(owner) {
      /** @type {Job[]} */
      let records = [];
      let succeeded = false, unreadable = false;
      try { records = await transaction('readonly', store => store.index('owner').getAll(owner)); succeeded = true; } catch { unreadable = everOpened; }
      try { records.push(...fallbackRecords(owner)); succeeded = true; } catch { /* storage blocked */ }
      if (!succeeded || unreadable) throw new Error('The local outbox is unavailable; keep your text in the editor');
      return [...new Map(records.filter(x => x.realm === realm).map(x => [x.key, x])).values()];
    },
    // one change by key: the write queue reads it again before sending (another tab may have sent it). A fallback copy
    // is the newer one (a successful IndexedDB write removes it); an unreadable database throws, never reads as gone.
    /** @param {string} key */
    async get(key) {
      /** @type {Job | null} */
      let record = null;
      try { record = JSON.parse(/** @type {string} */ (localStorage.getItem(PREFIX + key))); } catch { /* storage blocked */ }
      record ||= await transaction('readonly', store => store.get(key));
      return record && record.realm === realm ? record : null;
    },
    /** @param {string} key */
    async remove(key) {
      try { await transaction('readwrite', store => store.delete(key)); } catch { /* fallback may be in use */ }
      try { localStorage.removeItem(PREFIX + key); } catch { /* blocked */ }
    },
    /** @param {string} owner */
    async forget(owner) {
      /** @type {unknown[]} */
      const failed = [];
      // cleanup must never mistake an unreadable IndexedDB for an empty database
      if (typeof indexedDB !== 'undefined') {
        try {
          const records = await transaction('readonly', store => store.index('owner').getAll(owner));
          for (const r of records.filter(x => x.realm === realm)) await transaction('readwrite', store => store.delete(r.key));
        } catch (err) { failed.push(err); }
      }
      try { for (const r of fallbackRecords(owner).filter(x => x.realm === realm)) localStorage.removeItem(PREFIX + r.key); }
      catch (err) { failed.push(err); }
      if (failed.length) throw new Error('Some local copies could not be removed. Close other tabs of this app and clear its site storage before sharing the device.');
    },
  };
}
