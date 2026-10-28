// Minimal in-memory IndexedDB (only what src/outbox.js uses) with a switch that makes transactions throw,
// as a closing/lost connection does (Safari "Connection to Indexed Database server lost"), and a localStorage.
export function fakeIdb() {
  const dbs = new Map();
  const state = { broken: false };
  const later = fn => setTimeout(fn, 0);
  function request(run) { const r = {}; later(() => { try { r.result = run(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; }
  const api = {
    open(name) {
      const r = {};
      later(() => {
        let data = dbs.get(name); const fresh = !data;
        if (fresh) { data = new Map(); dbs.set(name, data); }
        const db = {
          objectStoreNames: { contains: n => n === 'changes' },
          createObjectStore() { return { createIndex() {} }; },
          close() {},
          transaction() {
            if (state.broken) { const e = new Error('Connection to Indexed Database server lost'); e.name = 'UnknownError'; throw e; }
            const tx = {}; let pending = 0;
            const done = () => { if (--pending === 0) later(() => tx.oncomplete?.()); };
            const wrap = fn => { pending++; const q = request(fn); setTimeout(done, 1); return q; };
            tx.objectStore = () => ({
              put: v => wrap(() => { data.set(v.key, structuredClone(v)); return v.key; }),
              get: k => wrap(() => data.has(k) ? structuredClone(data.get(k)) : undefined),
              delete: k => wrap(() => { data.delete(k); }),
              index: () => ({ getAll: o => wrap(() => [...data.values()].filter(x => x.owner === o).map(x => structuredClone(x))) }),
            });
            return tx;
          },
        };
        r.result = db;
        if (fresh) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  return { indexedDB: api, state, dbs };
}
export function fakeLocalStorage() {
  const s = {};
  Object.defineProperties(s, {
    getItem: { value: k => Object.hasOwn(s, k) ? s[k] : null },
    setItem: { value: (k, v) => { s[k] = String(v); } },
    removeItem: { value: k => { delete s[k]; } },
  });
  return s;
}
