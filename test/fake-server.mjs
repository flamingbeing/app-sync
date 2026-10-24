// A fake server for the engine's tests: collections of docs, live queries ("changed since" on a field), and a count
// of documents sent. Made-up data only.
// stamps may be numbers or ISO strings (as the engine's timeOf)
const when = v => typeof v === 'string' ? Date.parse(v) || 0 : Number(v) || 0;
export function fakeServer() {
  const colls = new Map();
  const coll = name => { if (!colls.has(name)) colls.set(name, new Map()); return colls.get(name); };
  const watchers = new Set();
  const srv = {
    reads: 0, listens: 0,
    get: (c, id) => coll(c).get(id),
    set(c, doc) { coll(c).set(doc.id, { ...doc }); for (const w of [...watchers]) if (w.coll === c) w.run(); },
    del(c, id) { coll(c).delete(id); for (const w of [...watchers]) if (w.coll === c) w.run(); },
    listen(_scope, c, { since = null, field = 'updatedAt' } = {}, onSnap) {
      srv.listens++;
      const w = { coll: c, prev: null };
      w.run = () => {
        const docs = [...coll(c).values()].filter(d => since === null || when(d[field]) > since).map(d => ({ ...d }));
        const next = new Map(docs.map(d => [d.id, JSON.stringify(d)])), changes = [];
        for (const d of docs) { const was = w.prev && w.prev.get(d.id); if (was !== next.get(d.id)) changes.push({ type: was ? 'modified' : 'added', id: d.id, doc: d }); }
        for (const id of (w.prev || new Map()).keys()) if (!next.has(id)) changes.push({ type: 'removed', id, doc: null });
        const first = w.prev === null;
        srv.reads += first ? Math.max(1, docs.length) : changes.filter(x => x.type !== 'removed').length;
        w.prev = next;
        if (first || changes.length) onSnap({ changes, fromCache: false, hasPendingWrites: false, ...(first && since === null ? { full: true, docs } : {}) });
      };
      watchers.add(w); w.run();
      return () => watchers.delete(w);
    },
    fetchOne(_scope, c, id) { srv.reads++; const d = coll(c).get(id); return d ? { ...d } : null; },
  };
  return srv;
}
