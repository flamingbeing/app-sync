import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteQueue } from '../src/writes.js';
import { checkWrite, recordSignature } from '../src/conflict.js';
// a made-up canonical form: empty arrays and false flags are left out, as a backend's cleaner might
const cleanCase = v => Object.fromEntries(Object.entries(v).filter(([, x]) => !(x === false || (Array.isArray(x) && !x.length))));
const clone = x => structuredClone(x);
function fixture() {
  const records = new Map(), remote = new Map();
  let owner = 'a', online = true, reject = false, deny = false;
  const store = { async put(x) { if (deny) throw Error('quota'); records.set(x.key, clone(x)); }, async list(o) { return [...records.values()].filter(x => x.owner === o).map(clone); }, async get(k) { return records.has(k) ? clone(records.get(k)) : null; }, async remove(k) { records.delete(k); }, async forget(o) { for (const [k,x] of records) if(x.owner===o) records.delete(k); } };
  const config = { store, getOwner: () => owner, online: () => online, delay: ms => new Promise(r => setTimeout(r, ms === 180 ? 5 : 100)), backend: async (_, kind, record, base) => {
    if (reject) throw Error('rejected'); const current = remote.get(record.id) || null;
    checkWrite(current, record._deleted ? null : record, base);
    if(record._deleted) remote.delete(record.id); else remote.set(record.id, clone(record)); return record;
  } };
  return { records, remote, config, queue: createWriteQueue(config), owner: x=>owner=x, online:x=>online=x, reject:x=>reject=x, deny:x=>deny=x };
}
test('unavailable durable storage never clears an editor or contacts backend', async () => {
  const f=fixture();f.deny(true);await assert.rejects(f.queue.save('item','a',{id:'1'}),/storage/);assert.equal(f.remote.size,0);assert.equal(f.queue.entries().length,0);
});
test('offline immutable payload survives restart and drains on reconnect', async () => {
  const f=fixture();f.online(false);const input={id:'1',details:'original'};
  const save=f.queue.save('item','a',input);input.details='mutated';await save;assert.equal(f.queue.overlay('item','a',[])[0].details,'original');
  const next=createWriteQueue(f.config);await next.activate('a');f.online(true);assert.equal(await next.flush(),true);assert.equal(f.remote.get('1').details,'original');
});
test('rejected writes keep recovery copy and explicit retry succeeds', async () => {
  const f=fixture();f.reject(true);try { await f.queue.save('item','a',{id:'1',details:'keep'}); } catch {}
  await f.queue.flush();const job=f.queue.entries()[0];assert.equal(job.state,'failed');assert.equal(f.records.get(job.key).record.details,'keep');
  f.reject(false);await f.queue.retry(job.key);assert.equal(f.queue.status('item','1'),'synced');assert.equal(f.remote.get('1').details,'keep');
});
test('concurrent edits preserve remote and local versions without overwrite', async () => {
  const f=fixture(),base={id:'1',details:'old'};f.remote.set('1',{...base,details:'other tab'});
  try { await f.queue.save('item','a',{...base,details:'mine'},base); } catch {}
  await f.queue.flush();const job=f.queue.entries()[0];assert.equal(job.state,'conflict');assert.equal(job.record.details,'mine');assert.equal(job.remote.details,'other tab');assert.equal(f.remote.get('1').details,'other tab');
});
test('offline sequential edits and undo deletion drain in order', async () => {
  const f=fixture();f.online(false);const first={id:'1',details:'one'},second={...first,details:'two'};
  await f.queue.save('item','a',first);await f.queue.save('item','a',second,first);await f.queue.save('item','a',{id:'1',_deleted:true},second);
  assert.equal(f.queue.overlay('item','a',[]).length,0);f.online(true);assert.equal(await f.queue.flush(),true);assert.equal(f.remote.size,0);
});
test('late acknowledgement from previous account cannot reinsert private history', async () => {
  const f=fixture();let finish;f.config.backend=()=>new Promise(r=>finish=r);const q=createWriteQueue(f.config);
  await q.save('item','a',{id:'1'});await q.forget();f.owner('b');await q.activate('b');finish({id:'1'});await Promise.resolve();await Promise.resolve();assert.equal(q.entries().length,0);assert.equal(f.records.size,0);
});
test('edits arriving during an in-flight write drain without an online event or manual flush', async () => {
  const f=fixture();let finish,started;const called=new Promise(r=>started=r),first={id:'1',details:'one'},second={...first,details:'two'};
  const backend=f.config.backend;let calls=0;f.config.backend=async (...args)=>{if(++calls===1){started();await new Promise(r=>finish=r);}return backend(...args);};
  const q=createWriteQueue(f.config);const one=q.save('item','a',first);await called;const two=q.save('item','a',second,first);await two;finish();await one;
  for(let i=0;i<20&&q.status('item','1')!=='synced';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(q.status('item','1'),'synced');assert.equal(f.remote.get('1').details,'two');
});

test('canonical offline versions do not conflict when the backend removes empty/false fields', async () => {
 const f=fixture();f.online(false);f.config.normalize=(kind,value)=>cleanCase(value);const backend=f.config.backend;
 f.config.backend=(email,kind,record,base)=>backend(email,kind,cleanCase(record),base);
 const q=createWriteQueue(f.config);const first=await q.save('item','a',{id:'normal',details:'one',tags:[],flag:false});
 assert.equal(first.tags,undefined);assert.equal(first.flag,undefined);
 await q.save('item','a',{...first,details:'two'},first);f.online(true);assert.equal(await q.flush(),true);assert.equal(f.remote.get('normal').details,'two');
});

test('sign-out check sees another tab’s unsynced change in the shared store', async () => {
  // two tabs (or the browser and the home-screen app) share the recovery store: tab B saves offline
  const f=fixture();f.online(false);const A=createWriteQueue(f.config),B=createWriteQueue(f.config);
  await A.activate('a');await B.save('item','a',{id:'tabB',details:'Fake item from tab B'});
  assert.equal(await A.flush(50),false,'not synced yet: the sign-out prompt shows');
  f.online(true);assert.equal(await B.flush(),true);assert.equal(await A.flush(50),true,'once B has synced it');
});
test('a save cut off by the network stays pending and lands on its own', async () => {
  const f=fixture();let drops=2;const send=f.config.backend;
  f.config.backend=async(...a)=>{if(drops-->0)throw Object.assign(Error('Failed to get document because the client is offline.'),{code:'unavailable'});return send(...a);};
  const q=createWriteQueue(f.config);await q.save('item','a',{id:'1',details:'flaky wifi'});
  assert.equal(q.status('item','1'),'pending');
  for(let i=0;i<40&&q.status('item','1')!=='synced';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(q.status('item','1'),'synced');assert.equal(f.remote.get('1').details,'flaky wifi');assert.equal(q.entries()[0].error,'');
});

// ---- after a conflict: later saves, the conflict choices, and what the list shows ----
const wait = async (ok, n = 40) => { for (let i = 0; i < n && !ok(); i++) await new Promise(r => setTimeout(r, 20)); };
const states = (q, id) => q.entries().filter(x => x.record.id === id).map(x => x.state + ':' + (x.record.details ?? x.record.text));
// this device edits offline from v1, another device edits meanwhile: the offline edit meets a conflict
async function conflicted(f, v1, mine, theirs, kind = 'item') {
  f.remote.set(v1.id, clone(v1)); f.online(false);
  await f.queue.save(kind, 'a', mine, v1);
  f.remote.set(v1.id, theirs); f.online(true); await f.queue.flush(50);
  assert.equal(f.queue.status(kind, v1.id), 'conflict');
}
test('a save after a conflict made on the version shown syncs, and sets the conflict aside', async () => {
  const f = fixture(), v1 = { id: 'Y', details: 'Fake v1' };
  await conflicted(f, v1, { ...v1, details: 'Fake offline edit' }, { ...v1, details: 'Fake edit on device B' });
  const shown = f.queue.overlay('item', 'a', [clone(f.remote.get('Y'))])[0];
  assert.equal(shown.details, 'Fake edit on device B');
  // opening it and saving it unchanged is no choice: the conflict stays
  await f.queue.save('item', 'a', { ...shown }, shown);
  assert.deepEqual(states(f.queue, 'Y'), ['conflict:Fake offline edit']);
  await f.queue.save('item', 'a', { ...shown, details: 'Fake edit after the conflict' }, shown);
  assert.equal(await f.queue.flush(), true, 'nothing left waiting');
  assert.equal(f.remote.get('Y').details, 'Fake edit after the conflict');
  assert.deepEqual(states(f.queue, 'Y'), ['synced:Fake edit after the conflict', 'archived:Fake offline edit']);
});
test('a save after a conflict made on this device’s own version fails and is kept (never sent, never piling up)', async () => {
  const f = fixture(), r0 = { id: 'R', text: 'Fake start' };
  f.remote.set('R', { ...r0, text: 'Fake start (laptop)' });
  // an editor that autosaves: the first autosave meets the conflict; its base stays, so each next autosave fails too
  await assert.rejects(f.queue.save('doc', 'a', { ...r0, text: 'Fake start + para 1' }, r0), /changed elsewhere/);
  await assert.rejects(f.queue.save('doc', 'a', { ...r0, text: 'Fake start + para 1 + 2' }, r0), /in Recover/);
  await assert.rejects(f.queue.save('doc', 'a', { ...r0, text: 'Fake start + para 1 + 2 + 3' }, r0), /in Recover/);
  assert.equal(await f.queue.flush(50), false);
  assert.equal(f.remote.get('R').text, 'Fake start (laptop)');
  assert.deepEqual(states(f.queue, 'R'), ['conflict:Fake start + para 1 + 2 + 3', 'archived:Fake start + para 1 + 2', 'conflict:Fake start + para 1']);
  assert.equal(f.queue.entries()[0].remote.text, 'Fake start (laptop)');
  // Restore my version (ui-recovery.js): the newest copy, saved over the other copy, replaces the stopped chain
  const [newest] = f.queue.entries();
  await f.queue.save('doc', 'a', newest.record, newest.remote);
  assert.equal(await f.queue.flush(), true);
  assert.equal(f.remote.get('R').text, 'Fake start + para 1 + 2 + 3');
});
test('Keep version from elsewhere sets aside that save and older ones, never a newer one', async () => {
  const f = fixture(), v1 = { id: 'K', details: 'Fake v1' }, one = { ...v1, details: 'Fake offline one' };
  f.remote.set('K', clone(v1)); f.online(false);
  // two saves accepted before the first met the conflict (a slow or absent connection)
  await f.queue.save('item', 'a', one, v1); await f.queue.save('item', 'a', { ...v1, details: 'Fake offline two' }, one);
  f.remote.set('K', { ...v1, details: 'Fake device B' }); f.online(true); await f.queue.flush(50);
  assert.deepEqual(states(f.queue, 'K'), ['pending:Fake offline two', 'conflict:Fake offline one']);
  // Retry on the save behind the conflict says why it can't go yet
  await assert.rejects(f.queue.retry(f.queue.entries()[0].key), /choose a version/);
  await f.queue.archive(f.queue.entries()[1].key);
  await wait(() => f.queue.status('item', 'K') !== 'pending');
  // the newer save goes next; it continued from this device's own version, so it meets the conflict too, and stays
  assert.deepEqual(states(f.queue, 'K'), ['conflict:Fake offline two', 'archived:Fake offline one']);
  assert.equal(f.remote.get('K').details, 'Fake device B');
});
test('Restore my version saves the newest of this device’s versions, not the conflict’s own', async () => {
  const f = fixture(), v1 = { id: 'M', details: 'Fake v1' }, one = { ...v1, details: 'Fake offline one' };
  f.remote.set('M', clone(v1)); f.online(false);
  await f.queue.save('item', 'a', one, v1); await f.queue.save('item', 'a', { ...v1, details: 'Fake offline two' }, one);
  f.remote.set('M', { ...v1, details: 'Fake device B' }); f.online(true); await f.queue.flush(50);
  const [newest, conflict] = f.queue.entries();
  await f.queue.save('item', 'a', newest.record, conflict.remote);
  assert.equal(await f.queue.flush(), true); assert.equal(f.remote.get('M').details, 'Fake offline two');
});
test('a conflict shows the list’s copy once the record was edited or deleted elsewhere', async () => {
  const f = fixture(), v1 = { id: 'X', details: 'Fake v1', cats: ['1'] }, mine = { ...v1, details: 'Fake mine' };
  await conflicted(f, v1, mine, { ...v1, details: 'Fake v2 device B' });
  const show = list => f.queue.overlay('item', 'a', list.map(clone)).map(c => c.details);
  // the list still has this device's own version (put there on saving) or the copy it started from: the other copy
  assert.deepEqual(show([mine]), ['Fake v2 device B']); assert.deepEqual(show([v1]), ['Fake v2 device B']);
  // edited again elsewhere (parked seed 285932884): the newer copy shows and is counted; Recent changes shows it too
  assert.deepEqual(show([{ ...v1, details: 'Fake v3 device B', cats: ['2'] }]), ['Fake v3 device B']);
  assert.equal(f.queue.entries()[0].remote.details, 'Fake v3 device B');
  // deleted elsewhere: it stays gone
  assert.deepEqual(show([]), []);
  // this device's own delete met the conflict: the record is still on the server, so it shows
  const g = fixture(), w = { id: 'W', details: 'Fake w1' };
  await conflicted(g, w, { id: 'W', _deleted: true }, { ...w, details: 'Fake w2 elsewhere' });
  assert.deepEqual(g.queue.overlay('item', 'a', []).map(c => c.details), ['Fake w2 elsewhere']);
});
test('a job another window has sent is not sent again from this window’s stale copy (one store, two windows)', async () => {
  // A: the installed app, signal drops mid-save; its retry waits (a frozen background page waits longer still)
  const f = fixture(); let flaky = true; const send = f.config.backend;
  const A = createWriteQueue({ ...f.config, delay: ms => new Promise(r => setTimeout(r, ms === 180 ? 5 : 200)),
    backend: async (...a) => { if (flaky) throw Object.assign(Error('Fake: the client is offline'), { code: 'unavailable' }); return send(...a); } });
  await A.save('item', 'a', { id: 'Z', details: 'Fake new item' });
  assert.equal(A.status('item', 'Z'), 'pending');
  // B: a browser tab sends it, then the user deletes the record there
  const B = createWriteQueue(f.config); await B.activate('a'); assert.equal(await B.flush(), true);
  await B.save('item', 'a', { id: 'Z', _deleted: true }, clone(f.remote.get('Z'))); assert.equal(f.remote.has('Z'), false);
  flaky = false; await wait(() => A.status('item', 'Z') !== 'pending');
  assert.equal(A.status('item', 'Z'), 'synced'); assert.equal(f.remote.has('Z'), false, 'the deleted record stays deleted');
  // a delete pending in A, sent by B, then restored in B: A must not delete it again
  const v = { id: 'W', details: 'Fake item' }; f.remote.set('W', clone(v)); flaky = true;
  await A.save('item', 'a', { id: 'W', _deleted: true }, v);
  const B2 = createWriteQueue(f.config); await B2.activate('a'); assert.equal(await B2.flush(), true); assert.equal(f.remote.has('W'), false);
  await B2.save('item', 'a', clone(v), null); assert.equal(f.remote.has('W'), true);
  flaky = false; await wait(() => A.status('item', 'W') !== 'pending');
  assert.equal(f.remote.has('W'), true, 'the restored record stays');
});
test('Retry in one window does not resend a save another window has already synced', async () => {
  const f = fixture(); f.reject(true); const A = createWriteQueue(f.config);
  await assert.rejects(A.save('item', 'a', { id: '1', details: 'Fake keep' }), /rejected/);
  const { key } = A.entries()[0]; f.reject(false);
  const B = createWriteQueue(f.config); await B.activate('a'); await B.retry(key); assert.equal(B.status('item', '1'), 'synced');
  await B.save('item', 'a', { id: '1', _deleted: true }, clone(f.remote.get('1'))); assert.equal(f.remote.has('1'), false);
  await A.retry(key); assert.equal(A.status('item', '1'), 'synced'); assert.equal(f.remote.has('1'), false);
  // and saving the same content again in A starts a new save instead of reviving the old one
  await A.save('item', 'a', { id: '1', details: 'Fake keep' }, null); assert.equal(f.remote.get('1').details, 'Fake keep');
});

// ---- review of the fix above (15 Oct 2026) ----
// case A: a first save accepted, then rejected (not the network), with a newer save waiting behind it
async function stuckBehindFailed(f, q, v1) {
  f.remote.set(v1.id, clone(v1)); f.online(false);
  const one = { ...v1, details: 'Fake edit 1' };
  await q.save('item', 'a', one, v1); await q.save('item', 'a', { ...v1, details: 'Fake edit 2' }, one);
  f.online(true); await q.flush(50);
  assert.deepEqual(states(q, v1.id), ['pending:Fake edit 2', 'failed:Fake edit 1']);
}
test('Restore on a save waiting behind a failed one saves it from the server’s copy, and it lands', async () => {
  const f = fixture(), v1 = { id: 'S', details: 'Fake v1' }, send = f.config.backend;
  // only that one version is rejected, so Retry on it can never help
  const q = createWriteQueue({ ...f.config, backend: async (...a) => { if (a[2].details === 'Fake edit 1') throw Error('Fake: this version is rejected'); return send(...a); } });
  await stuckBehindFailed(f, q, v1);
  // Restore this version on the newest card queued one more save behind the failed one, said 'Version restored', and
  // never synced; the list's copy (the newest accepted save) is not what the server holds
  const [newest] = q.entries();
  await q.restore('item', 'a', newest.record, newest.record);
  assert.equal(await q.flush(), true, 'nothing left waiting');
  assert.equal(f.remote.get('S').details, 'Fake edit 2');
  assert.deepEqual(states(q, 'S'), ['synced:Fake edit 2', 'archived:Fake edit 2', 'archived:Fake edit 1']);
});
test('Retry on a save waiting behind a failed one sends the failed one again first', async () => {
  const f = fixture(), v1 = { id: 'T', details: 'Fake v1' };
  f.reject(true); await stuckBehindFailed(f, f.queue, v1); f.reject(false);
  await f.queue.retry(f.queue.entries()[0].key);
  assert.equal(await f.queue.flush(), true); assert.equal(f.remote.get('T').details, 'Fake edit 2');
});
test('a conflict shows a copy saved again elsewhere with the content this device started from (a restore)', async () => {
  // every save stamps a newer updatedAt (clean.js), so a restore elsewhere is a newer version than this device's base
  const show = (f, list) => f.queue.overlay('item', 'a', list.map(clone)).map(c => c.details);
  // the other device deleted it (this edit met the delete); then it was restored from the bin elsewhere
  const f = fixture(), v1 = { id: 'B', details: 'Fake v1', updatedAt: 1 };
  f.remote.set('B', clone(v1)); f.online(false);
  await f.queue.save('item', 'a', { ...v1, details: 'Fake offline edit' }, v1);
  f.remote.delete('B'); f.online(true); await f.queue.flush(50);
  assert.equal(f.queue.status('item', 'B'), 'conflict');
  assert.deepEqual(show(f, [v1]), [], 'a stale cached list (that very version) still shows the delete');
  assert.deepEqual(show(f, [{ ...v1, updatedAt: 5 }]), ['Fake v1'], 'the restored case shows and is counted');
  assert.equal(f.queue.entries()[0].remote.details, 'Fake v1');
  // the other device used Restore previous version, back to the copy this device started from
  const g = fixture(), w1 = { id: 'C', details: 'Fake w1', updatedAt: 1 };
  await conflicted(g, w1, { ...w1, details: 'Fake offline edit' }, { ...w1, details: 'Fake w2 elsewhere', updatedAt: 3 });
  assert.deepEqual(show(g, [w1]), ['Fake w2 elsewhere']);
  assert.deepEqual(show(g, [{ ...w1, updatedAt: 5 }]), ['Fake w1']);
  assert.equal(g.queue.entries()[0].remote.details, 'Fake w1', 'Recent changes shows it too');
});
test('a save another window sent, and later dropped from its history (100 newer), is not sent again', async () => {
  const f = fixture(); let flaky = true; const send = f.config.backend;
  const A = createWriteQueue({ ...f.config, delay: ms => new Promise(r => setTimeout(r, ms === 180 ? 5 : 200)),
    backend: async (...a) => { if (flaky) throw Object.assign(Error('Fake: the client is offline'), { code: 'unavailable' }); return send(...a); } });
  await A.save('item', 'a', { id: 'Z', details: 'Fake new item' });
  const B = createWriteQueue(f.config); await B.activate('a'); assert.equal(await B.flush(), true);
  await B.save('item', 'a', { id: 'Z', _deleted: true }, clone(f.remote.get('Z')));
  for (let i = 0; i < 100; i++) await B.save('note', 'a', { id: 'n' + i, text: 'Fake note ' + i });
  assert.equal(await B.flush(), true);
  assert.equal([...f.records.values()].some(x => x.record.id === 'Z'), false, 'B kept only its 100 newest');
  flaky = false; await wait(() => A.status('item', 'Z') !== 'pending');
  assert.equal(f.remote.has('Z'), false, 'the deleted record stays deleted');
});
test('Keep version from elsewhere on the first card also sets aside the held copies behind it (one tap)', async () => {
  const f = fixture(), r0 = { id: 'E', details: 'Fake start' };
  f.remote.set('E', { ...r0, details: 'Fake laptop' });
  await assert.rejects(f.queue.save('doc', 'a', { ...r0, details: 'Fake p1' }, r0));
  await assert.rejects(f.queue.save('doc', 'a', { ...r0, details: 'Fake p1 p2' }, r0));
  assert.deepEqual(states(f.queue, 'E'), ['conflict:Fake p1 p2', 'conflict:Fake p1']);
  await f.queue.archive(f.queue.entries()[1].key);
  assert.deepEqual(states(f.queue, 'E'), ['archived:Fake p1 p2', 'archived:Fake p1']);
  assert.equal(f.queue.pending(), 0); assert.equal(f.remote.get('E').details, 'Fake laptop');
});
test('a save set aside while it is being sent stays set aside, and the next save goes', async () => {
  const f = fixture(), v1 = { id: 'G', details: 'Fake v1' }, theirs = { ...v1, details: 'Fake elsewhere' }, send = f.config.backend;
  f.remote.set('G', clone(theirs));
  let release = null;
  const q = createWriteQueue({ ...f.config, backend: async (...a) => { if (a[2].details === 'Fake mine') await new Promise(r => release = r); return send(...a); } });
  await q.save('item', 'a', { ...v1, details: 'Fake mine' }, v1);
  await wait(() => release);
  await q.archive(q.entries()[0].key);
  await q.save('item', 'a', { ...theirs, details: 'Fake next' }, theirs);
  release(); await wait(() => q.status('item', 'G') === 'synced');
  assert.deepEqual(states(q, 'G'), ['synced:Fake next', 'archived:Fake mine'], 'it met the conflict, but stays set aside');
  assert.equal(f.remote.get('G').details, 'Fake next');
});
test('a save on the other copy says this device’s version is kept, and keeps it past the 100-save history', async () => {
  const f = fixture(), notices = [], v1 = { id: 'F', details: 'Fake v1', cats: ['1'] };
  f.queue.configure({ notice: m => notices.push(m) });
  await conflicted(f, v1, { ...v1, details: 'Fake details typed in theatre' }, { ...v1, cats: ['1', '2'] });
  const shown = f.queue.overlay('item', 'a', [clone(f.remote.get('F'))])[0];
  await f.queue.save('item', 'a', { ...shown, tags: ['1:fake'] }, shown);
  assert.equal(await f.queue.flush(), true);
  assert.deepEqual(notices, ['Your version from this device is kept in Recover']);
  for (let i = 0; i < 101; i++) await f.queue.save('note', 'a', { id: 'n' + i, text: 'Fake note ' + i });
  assert.equal(await f.queue.flush(), true);
  assert.ok([...f.records.values()].some(x => x.record.details === 'Fake details typed in theatre' && x.state === 'archived'), 'still in Recent changes');
  // Restore my version saves this device's own version: nothing to say
  const g = fixture(), heard = [], w = { id: 'W', details: 'Fake w1' };
  g.queue.configure({ notice: m => heard.push(m) });
  await conflicted(g, w, { ...w, details: 'Fake mine' }, { ...w, details: 'Fake theirs' });
  await g.queue.restore('item', 'a', g.queue.entries()[0].record, null);
  assert.equal(await g.queue.flush(), true); assert.equal(g.remote.get('W').details, 'Fake mine'); assert.deepEqual(heard, []);
});
test('opening the other copy and saving it unchanged changes nothing, compared as the editor saves it', async () => {
  const f = fixture(), v1 = { id: 'N', details: 'Fake v1' };
  // (the editor's save fills in defaults the server's copy may not have)
  const q = createWriteQueue({ ...f.config, normalize: (_kind, v) => v._deleted ? v : { cats: [], ...v } });
  f.remote.set('N', clone(v1)); f.online(false);
  await q.save('item', 'a', { ...v1, details: 'Fake mine' }, v1);
  f.remote.set('N', { ...v1, details: 'Fake theirs' }); f.online(true); await q.flush(50);
  const shown = q.overlay('item', 'a', [clone(f.remote.get('N'))])[0];
  await q.save('item', 'a', { ...shown }, shown);
  assert.deepEqual(states(q, 'N'), ['conflict:Fake mine'], 'the conflict is still there to choose');
});
test('one job followed by its key while a later save of the same record waits behind it', async () => {
  // a delete waiting for signal, then a restore of the same record: status() is the restore's, stateOf(key) the delete's
  const f=fixture();f.remote.set('1',{id:'1',details:'kept'});f.online(false);
  await f.queue.save('item','a',{id:'1',_deleted:true},{id:'1',details:'kept'});const key=f.queue.jobKey('item','1');
  f.remote.set('1',{id:'1',details:'changed elsewhere'});await f.queue.save('item','a',{id:'1',details:'kept'});
  assert.notEqual(f.queue.jobKey('item','1'),key);f.online(true);f.queue.kick();
  for(let i=0;i<40&&f.queue.stateOf(key)==='pending';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(f.queue.stateOf(key),'conflict');assert.equal(f.queue.status('item','1'),'pending','the restore waits behind it');
  assert.equal(f.queue.stateOf('nope'),'');assert.equal(f.queue.jobKey('item','none'),'');
});

// 0.8.2: refused saves and job data that survive a reload, inside the stored-format promise (no new state)
const coded = code => Object.assign(new Error('Missing or insufficient permissions.'), { code });
test('a refused save keeps its code across a reload; set aside as refused it outlives 100+ finished saves; refused(), retry() (0.8.2)', async () => {
  const f = fixture(); let deny = true;
  const config = { ...f.config, backend: async (o, kind, record, base, extra) => { if (deny && record.id === 'r') throw coded('permission-denied'); return f.config.backend(o, kind, record, base, extra); } };
  const q = createWriteQueue(config);
  await assert.rejects(q.save('item', 'a', { id: 'r', text: 'Fake' }), /kept/);
  const key = q.entries()[0].key;
  assert.equal(q.entries()[0].code, 'permission-denied');
  const again = createWriteQueue(config); await again.activate('a');
  assert.equal(again.entries()[0].code, 'permission-denied', 'the code survives a reload');
  assert.deepEqual(again.refused().map(x => x.key), [key], 'a failed save is refused');
  await again.archive(key, { refused: true });
  assert.equal(f.records.get(key).state, 'archived', 'no new state: older versions count it finished');
  assert.equal(f.records.get(key).refused, true);
  assert.deepEqual(again.refused().map(x => [x.key, x.code]), [[key, 'permission-denied']], 'still refused, set aside');
  for (let i = 0; i < 105; i++) await again.save('item', 'a', { id: 'x' + i, text: 'Fake' });
  assert.equal(await again.flush(), false, 'set aside, not given up: the sign-out gate stays shut (review)');
  assert.ok(f.records.has(key), 'kept out of pruning');
  const third = createWriteQueue(config); await third.activate('a');
  assert.deepEqual(third.refused().map(x => x.key), [key], 'and after another reload');
  deny = false; await third.retry(key);
  assert.equal(f.remote.get('r').text, 'Fake', 'sent (then pruned at once: the oldest finished save)');
  assert.deepEqual(third.refused(), []); assert.equal(f.records.get(key)?.refused, undefined);
});
test('discard(key): a refused save leaves the refused list and becomes ordinary history (0.8.2)', async () => {
  const f = fixture();
  const config = { ...f.config, backend: async () => { throw coded('permission-denied'); } };
  const q = createWriteQueue(config);
  await assert.rejects(q.save('item', 'a', { id: 'r', text: 'Fake' }), /kept/);
  const key = q.entries()[0].key;
  await q.discard(key);
  assert.equal(q.stateOf(key), 'archived'); assert.deepEqual(q.refused(), []);
  assert.equal(f.records.get(key).refused, undefined); assert.equal(await q.flush(), true);
  await assert.rejects(q.save('item', 'a', { id: 's', text: 'Fake' }), /kept/);
  const k2 = q.jobKey('item', 's');
  await q.archive(k2, { refused: true }); assert.equal(await q.flush(), false, 'set aside: still shut');
  await q.discard(k2);   // given up later
  assert.deepEqual(q.refused(), []); assert.equal(f.records.get(k2).refused, undefined); assert.equal(await q.flush(), true);
});
test('save(..., { meta }) is kept with the job across a reload: entries() and finished(key) (0.8.2)', async () => {
  const f = fixture(); f.online(false);
  await f.queue.save('item', 'a', { id: '1', text: 'Fake' }, null, { meta: { row: 3, label: 'Fake row' } });
  const key = f.queue.jobKey('item', '1');
  assert.equal(f.queue.finished(key), null, 'not sent yet');
  const next = createWriteQueue(f.config); await next.activate('a');
  assert.deepEqual(next.entries()[0].meta, { row: 3, label: 'Fake row' });
  f.online(true); assert.equal(await next.flush(), true);
  const done = next.finished(key);
  assert.equal(done.state, 'synced'); assert.deepEqual(done.meta, { row: 3, label: 'Fake row' });
});
test('lastSent(kind, id) survives a reload: the stamp and signature this device last sent (0.8.2)', async () => {
  const f = fixture();
  const config = { ...f.config, backend: async (...args) => { const r = await f.config.backend(...args); return { ...r, updatedAt: 42 }; } };
  const q = createWriteQueue(config);
  assert.equal(q.lastSent('item', '1'), null);
  await q.save('item', 'a', { id: '1', text: 'Fake' }); assert.equal(await q.flush(), true);
  const next = createWriteQueue(config); await next.activate('a');
  assert.deepEqual(next.lastSent('item', '1'), { stamp: 42, signature: recordSignature({ id: '1', text: 'Fake' }) });
  assert.equal(next.lastSent('item', '2'), null);
});
test('lastSent signs what the server stored (a merge), without the engine fields (review, 0.8.2)', async () => {
  const f = fixture();
  const config = { ...f.config, engine: ['serverAt'], backend: async (_o, _k, record) => ({ ...record, other: 'merged elsewhere', serverAt: { sentinel: true }, updatedAt: 9 }) };
  const q = createWriteQueue(config);
  await q.save('item', 'a', { id: '1', text: 'Fake' }); assert.equal(await q.flush(), true);
  assert.deepEqual(q.lastSent('item', '1'), { stamp: 9, signature: recordSignature({ id: '1', text: 'Fake', other: 'merged elsewhere' }) });
});
test('a bulk import is sent a few records at a time, each within its send timeout (1.5.5)', async () => {
  // a server that answers more slowly the more it is sent at once: 20 at once would all miss the 200 ms timeout
  const f=fixture();let inFlight=0,most=0,calls=0;const store=f.config.store;
  const queue=createWriteQueue({ ...f.config, store, sendTimeout: 200, backend: async (_, kind, record) => {
    calls++;inFlight++;most=Math.max(most,inFlight);await new Promise(r=>setTimeout(r,30*inFlight));inFlight--;f.remote.set(record.id,clone(record));return record;
  } });
  await queue.activate('a');
  await Promise.all(Array.from({length:20},(_,i)=>queue.save('item','a',{id:'r'+i,details:'x'})));
  // (the fixture's delay makes flush wait only 100 ms: wait for the queue itself)
  for (const t=Date.now();queue.pending()&&Date.now()-t<5000;) await new Promise(r=>setTimeout(r,20));
  assert.equal(queue.pending(),0);
  assert.ok(most<=6,'at most 6 in flight, saw '+most);assert.equal(calls,20,'none timed out and was sent again');assert.equal(f.remote.size,20);
});
