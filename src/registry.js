// The outbox registry: every app on one origin names its outbox here. The apps on one origin share sign-in, so
// signing out in one signs out all of them; with the registry, the sign-out check (queue.flush) also waits for the
// other apps' unsent saves for this user, and forgetting the device (queue.forget) forgets this user in all of them.
// Opt-in: an app that doesn't register its outbox, or whose queue has no registry, is not looked at and works as before.
//
// createOutboxRegistry({ storage, open, key, timeout }) -> { register, unregister, list, unsent, forget }
//   storage: where the list is kept (localStorage: every page of the origin reads it). open(name, realm): an outbox
//   by name (createOutbox). timeout: ms an outbox may take to answer before it counts as unsent.
//   register(outbox | { name, realm }): idempotent; call it at start-up. list() -> [{ name, realm }].
//   unsent(owner, { except }) -> true while any registered outbox (except this one: the queue checks its own) has
//   saves for owner that are not sent; an outbox that can't be read or doesn't answer counts as unsent.
//   forget(owner, { except }): this owner's entries in every registered outbox; throws after trying all if any failed.
import { createOutbox } from './outbox.js';

export const REGISTRY_KEY = 'app-sync:outboxes';
export const REGISTRY_TIMEOUT = 3000;
const done = new Set(['synced', 'archived']);   // the write queue's finished states (writes.js)
const idOf = x => ({ name: x.name, realm: x.realm || 'default' });
const same = (a, b) => a.name === b.name && (a.realm || 'default') === (b.realm || 'default');

export function createOutboxRegistry({ storage = globalThis.localStorage, open = (name, realm) => createOutbox({ name, realm }), key = REGISTRY_KEY, timeout = REGISTRY_TIMEOUT } = {}) {
  const read = () => {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const all = JSON.parse(raw);
    return Array.isArray(all) ? all.filter(x => x && typeof x.name === 'string').map(idOf) : [];
  };
  const opened = new Map();
  const outbox = x => { const id = x.name + '\n' + x.realm; if (!opened.has(id)) opened.set(id, open(x.name, x.realm)); return opened.get(id); };
  const others = except => read().filter(x => !(except && except.name && same(x, except)));
  const within = p => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('An outbox did not answer in time')), timeout); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };
  return {
    list: read,
    register(x) {
      if (!x || !x.name) throw new Error('register needs an outbox name');
      const all = read();
      if (!all.some(y => same(y, x))) storage.setItem(key, JSON.stringify([...all, idOf(x)]));
    },
    unregister(x) { storage.setItem(key, JSON.stringify(read().filter(y => !same(y, x)))); },
    async unsent(owner, { except = null } = {}) {
      let list;
      try { list = others(except); } catch { return true; }   // the list can't be read: not known to be empty
      const one = async x => { try { return (await within(Promise.resolve().then(() => outbox(x).list(owner)))).some(e => !done.has(e.state)); } catch { return true; } };
      return (await Promise.all(list.map(one))).some(Boolean);
    },
    async forget(owner, { except = null } = {}) {
      const failed = [];
      for (const x of others(except)) { try { await within(Promise.resolve().then(() => outbox(x).forget(owner))); } catch (e) { failed.push(x.name + ': ' + (e && e.message)); } }
      if (failed.length) throw new Error('Some local copies could not be removed (' + failed.join('; ') + '). Close other tabs of these apps and clear the site storage before sharing the device.');
    },
  };
}
