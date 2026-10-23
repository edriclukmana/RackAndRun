// Checks www/backend.js (the Firebase adapter) against an in-memory stand-in for Firestore.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../www/backend.js', import.meta.url), 'utf8');
const win = { navigator: { onLine: true } };
vm.runInNewContext(src, { window: win, navigator: win.navigator, console, setTimeout, Promise, JSON, Date, Math, Object, String, Array });
const { makeApi } = win.RRBackend;

// --- a tiny fake of the Firestore functions backend.js calls ---
const store = new Map(), docSubs = new Map(), querySubs = [];
const snap = (id, data) => ({ id, exists: () => data !== undefined, data: () => (data === undefined ? undefined : structuredClone(data)), metadata: { fromCache: false, hasPendingWrites: false } });
const colOf = p => p.split('/').slice(0, -1).join('/');
function runQuery(q) {
  let docs = [...store.entries()].filter(([p]) => colOf(p) === q.col).map(([p, d]) => snap(p.split('/').pop(), d));
  for (const c of q.cons) {
    if (c.t === 'where' && c.op === 'in') docs = docs.filter(s => c.v.includes(s.data()[c.f]));
    if (c.t === 'where' && c.op === '==') docs = docs.filter(s => s.data()[c.f] === c.v);
    if (c.t === 'limit') docs = docs.slice(0, c.n);
  }
  return { docs, metadata: { fromCache: false, hasPendingWrites: false } };
}
function changed(path) {
  (docSubs.get(path) || []).forEach(fn => fn(snap(path.split('/').pop(), store.get(path))));
  querySubs.forEach(({ q, fn }) => { if (q.col === colOf(path)) fn(runQuery(q)); });
}
let auto = 0;
const fb = {
  doc: (db, path) => ({ path, id: path.split('/').pop() }),
  collection: (db, col) => ({ col }),
  query: (c, ...cons) => ({ col: c.col, cons }),
  where: (f, op, v) => ({ t: 'where', f, op, v }),
  limit: n => ({ t: 'limit', n }),
  orderBy: (f, d) => ({ t: 'orderBy', f, d }),
  getDoc: async ref => snap(ref.id, store.get(ref.path)),
  setDoc: async (ref, data, opt) => { store.set(ref.path, opt && opt.merge ? { ...(store.get(ref.path) || {}), ...data } : structuredClone(data)); changed(ref.path); },
  deleteDoc: async ref => { store.delete(ref.path); changed(ref.path); },
  getDocs: async q => runQuery(q),
  runTransaction: async (db, fn) => {
    const writes = [];
    const tx = { get: async ref => snap(ref.id, store.get(ref.path)), set: (ref, data, opt) => writes.push([ref, data, opt]) };
    const r = await fn(tx);
    for (const [ref, data, opt] of writes) await fb.setDoc(ref, data, opt);
    return r;
  },
  onSnapshot: (target, next) => {
    if (target.path) {
      const list = docSubs.get(target.path) || []; list.push(next); docSubs.set(target.path, list);
      next(snap(target.id, store.get(target.path)));
      return () => docSubs.set(target.path, docSubs.get(target.path).filter(f => f !== next));
    }
    const entry = { q: target, fn: next }; querySubs.push(entry); next(runQuery(target));
    return () => querySubs.splice(querySubs.indexOf(entry), 1);
  }
};
fb.doc = (db, a) => (a.col ? { path: a.col + '/auto' + (++auto), id: 'auto' + auto } : { path: a, id: a.split('/').pop() });

const api = makeApi(fb, {}, 'uid-1');
const db = api.db;

// 1. Round trip keeps nested arrays (the table is a list of sets) and exposes status for queries.
const game = { status: 'playing', updatedAt: 5, G: { table: [[1, 2, 3], [40, 41, 42]], players: [{ rack: [7, 8] }] }, seats: { 0: { type: 'human', uid: 'uid-1' } } };
await db.doc('games/t1').set(game);
assert.equal(store.get('games/t1').status, 'playing');
assert.equal(typeof store.get('games/t1')._json, 'string');
const back = await db.doc('games/t1').get();
assert.equal(back.exists, true);
assert.deepEqual(back.data(), game);

// 2. update() merges nested objects (claiming one seat leaves the others) and replaces arrays.
await db.doc('games/t1').update({ seats: { 2: { type: 'human', uid: 'uid-2', name: 'Bea' } }, G: { table: [[9, 10, 11]] } });
const merged = (await db.doc('games/t1').get()).data();
assert.equal(merged.seats[0].uid, 'uid-1');
assert.equal(merged.seats[2].name, 'Bea');
assert.deepEqual(merged.G.table, [[9, 10, 11]]);
assert.deepEqual(merged.G.players, [{ rack: [7, 8] }]);

// 3. update() on a missing document rejects with invalid_argument, as the game expects.
await assert.rejects(db.doc('games/nope').update({ a: 1 }), e => e.code === 'invalid_argument');

// 4. Leases: one holder at a time, renewal by the same holder, free after expiry.
const lock = db.doc('locks/t1');
assert.equal((await lock.acquire({ holder: 'A', ttlMs: 1000 })).acquired, true);
assert.equal((await lock.acquire({ holder: 'B', ttlMs: 1000 })).acquired, false);
assert.equal((await lock.acquire({ holder: 'A', ttlMs: 1000 })).acquired, true);
store.set('locks/t1', { leaseHolder: 'A', leaseExp: Date.now() - 1 });
assert.equal((await lock.acquire({ holder: 'B', ttlMs: 1000 })).acquired, true);

// 5. The table list query filters on status and stays live.
await db.doc('games/t2').set({ status: 'lobby', updatedAt: 6, seats: {} });
await db.doc('games/t3').set({ status: 'closed', updatedAt: 7 });
let lastIds = null;
const stop = db.collection('games').where('status', 'in', ['lobby', 'playing']).limit(80).onSnapshot(qs => { lastIds = qs.docs.map(d => d.id).sort(); });
assert.deepEqual(lastIds, ['t1', 't2']);
await db.doc('games/t4').set({ status: 'lobby', updatedAt: 8 });
assert.deepEqual(lastIds, ['t1', 't2', 't4']);
stop();

// 6. Document subscriptions deliver decoded data on every change.
const seen = [];
const unsub = db.doc('games/t2').onSnapshot(s => seen.push(s.exists ? s.data().status : null));
await db.doc('games/t2').set({ status: 'playing', updatedAt: 9 });
unsub();
assert.deepEqual(seen, ['lobby', 'playing']);

// 7. Identity.
assert.equal(await api.user.id(), 'uid-1');
assert.equal(await api.user.can('data.write'), true);

console.log('ok: Firebase adapter passes 7 checks');
