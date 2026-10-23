/*
 * Rack & Run: online play for the Android app and the website.
 *
 * The game only knows a small storage interface: window.claude.use('db') and
 * window.claude.use('user'). Inside Claude that interface is built in. Here it
 * is provided on top of Firebase: anonymous sign-in (each device is a player)
 * and Cloud Firestore (one document per table, updated live on every device).
 *
 * Nothing loads until the game asks for online play, so one-device games work
 * offline and start instantly.
 */
(function () {
  'use strict';
  window.RR_STANDALONE = true;
  window.RR_ONLINE_STATUS = 'idle';

  /* ---------- helpers ---------- */
  function isConfigured(c) {
    return !!(c && c.apiKey && c.projectId && !/PASTE|YOUR[_-]/i.test(c.apiKey + c.projectId));
  }
  function toCode(e) {
    const c = String((e && e.code) || '');
    if (c === 'invalid_argument' || c === 'resource_exhausted' || c === 'unavailable') return c;
    if (/permission-denied|invalid-argument|failed-precondition|not-found|unauthenticated/.test(c)) return 'invalid_argument';
    if (/resource-exhausted/.test(c)) return 'resource_exhausted';
    return 'unavailable';
  }
  function toError(e) { return { code: toCode(e), message: String((e && e.message) || e) }; }
  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  /* Nested objects merge; arrays, scalars and null replace. Same rule the game expects from update(). */
  function deepMerge(target, patch) {
    const out = isPlainObject(target) ? Object.assign({}, target) : {};
    Object.keys(patch).forEach(function (k) {
      const v = patch[k];
      out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
    });
    return out;
  }
  /* Firestore can't store arrays inside arrays (the table is a list of sets), so each
     document is kept as JSON text, with `status` and `updatedAt` copied out for queries. */
  function encode(data) {
    return {
      _json: JSON.stringify(data),
      status: data && data.status !== undefined ? data.status : null,
      updatedAt: data && typeof data.updatedAt === 'number' ? data.updatedAt : null
    };
  }
  function decode(raw) {
    if (raw && typeof raw._json === 'string') {
      try { return JSON.parse(raw._json); } catch (e) { /* fall through */ }
    }
    return raw;
  }
  function wrapDoc(id, snap) {
    const exists = snap.exists();
    return {
      id: id,
      exists: exists,
      data: function () { return exists ? decode(snap.data()) : undefined; },
      metadata: { fromCache: !!snap.metadata.fromCache, hasPendingWrites: !!snap.metadata.hasPendingWrites }
    };
  }
  function wrapQuery(qs) {
    const docs = qs.docs.map(function (d) { return wrapDoc(d.id, d); });
    return {
      docs: docs, size: docs.length, empty: !docs.length,
      docChanges: function () { return []; },
      metadata: { fromCache: !!qs.metadata.fromCache, hasPendingWrites: !!qs.metadata.hasPendingWrites }
    };
  }

  /* ---------- the interface the game uses ---------- */
  function makeApi(fb, db, uid) {
    function docRef(path) {
      const ref = fb.doc(db, path);
      return {
        id: ref.id,
        path: path,
        get: async function () {
          try { return wrapDoc(ref.id, await fb.getDoc(ref)); } catch (e) { throw toError(e); }
        },
        set: async function (data) {
          try { await fb.setDoc(ref, encode(data)); } catch (e) { throw toError(e); }
        },
        update: async function (patch) {
          try {
            await fb.runTransaction(db, async function (tx) {
              const snap = await tx.get(ref);
              if (!snap.exists()) throw { code: 'invalid_argument', message: 'That document does not exist.' };
              tx.set(ref, encode(deepMerge(decode(snap.data()), patch)));
            });
          } catch (e) { throw toError(e); }
        },
        delete: async function () {
          try { await fb.deleteDoc(ref); } catch (e) { throw toError(e); }
        },
        /* A short lease, so two devices never run the same bot turn or claim the same seat. */
        acquire: async function (opts) {
          const holder = String(opts && opts.holder);
          const ttl = Math.min(600000, Math.max(1000, (opts && opts.ttlMs) || 30000));
          let granted = false, expiresAt = 0;
          try {
            await fb.runTransaction(db, async function (tx) {
              const snap = await tx.get(ref);
              const cur = snap.exists() ? snap.data() : null;
              const now = Date.now();
              if (!cur || !cur.leaseExp || cur.leaseExp < now || cur.leaseHolder === holder) {
                expiresAt = now + ttl; granted = true;
                tx.set(ref, { leaseHolder: holder, leaseExp: expiresAt }, { merge: true });
              } else { granted = false; expiresAt = cur.leaseExp; }
            });
          } catch (e) { return { acquired: false }; }
          return granted ? { acquired: true, holder: holder, expiresAt: new Date(expiresAt).toISOString() }
                         : { acquired: false, expiresAt: new Date(expiresAt).toISOString() };
        },
        onSnapshot: function (next, error) {
          return fb.onSnapshot(ref, function (snap) { next(wrapDoc(ref.id, snap)); },
            function (e) { if (error) error(toError(e)); });
        },
        collection: function (sub) { return collectionRef(path + '/' + sub); }
      };
    }
    function queryRef(col, parts) {
      function build() {
        return fb.query.apply(null, [fb.collection(db, col)].concat(parts.map(function (p) {
          if (p[0] === 'where') return fb.where(p[1], p[2], p[3]);
          if (p[0] === 'orderBy') return fb.orderBy(p[1], p[2] || 'asc');
          return fb.limit(p[1]);
        })));
      }
      return {
        where: function (f, op, v) { return queryRef(col, parts.concat([['where', f, op, v]])); },
        orderBy: function (f, dir) { return queryRef(col, parts.concat([['orderBy', f, dir]])); },
        limit: function (n) { return queryRef(col, parts.concat([['limit', n]])); },
        get: async function () {
          try { return wrapQuery(await fb.getDocs(build())); } catch (e) { throw toError(e); }
        },
        onSnapshot: function (next, error) {
          return fb.onSnapshot(build(), function (qs) { next(wrapQuery(qs)); },
            function (e) { if (error) error(toError(e)); });
        }
      };
    }
    function collectionRef(col) {
      const q = queryRef(col, []);
      q.path = col;
      q.doc = function (id) { return docRef(col + '/' + (id || fb.doc(fb.collection(db, col)).id)); };
      q.add = async function (data) { const r = q.doc(); await r.set(data); return r; };
      return q;
    }
    const dbApi = Object.freeze({ doc: docRef, collection: collectionRef });
    const userApi = Object.freeze({
      id: async function () { return uid; },
      me: async function () { return { id: uid, name: '', email: null, isOwner: false, canEdit: true }; },
      can: async function () { return true; },
      canEdit: async function () { return true; },
      isOwner: async function () { return false; }
    });
    return { db: dbApi, user: userApi };
  }

  /* ---------- start-up ---------- */
  let starting = null;
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
  }
  function start() {
    if (starting) return starting;
    starting = (async function () {
      const cfg = window.RR_FIREBASE_CONFIG;
      if (!isConfigured(cfg)) { window.RR_ONLINE_STATUS = 'unconfigured'; return null; }
      window.RR_ONLINE_STATUS = 'connecting';
      try {
        const fb = await import('./vendor/firebase.js');
        const app = fb.initializeApp(cfg);
        const auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
        await withTimeout(auth.authStateReady(), 10000);
        const user = auth.currentUser || (await withTimeout(fb.signInAnonymously(auth), 15000)).user;
        const db = fb.getFirestore(app);
        window.RR_ONLINE_STATUS = 'ok';
        return makeApi(fb, db, user.uid);
      } catch (e) {
        console.warn('Rack & Run: online play is unavailable.', e);
        window.RR_ONLINE_STATUS = navigator.onLine === false || (e && e.message === 'timeout') ? 'offline' : 'error';
        starting = null; /* let the next attempt try again */
        return null;
      }
    })();
    return starting;
  }

  window.claude = Object.freeze({
    use: async function (name) {
      if (name !== 'db' && name !== 'user') return null;
      const api = await start();
      return api ? api[name] : null;
    }
  });
  window.RRBackend = { makeApi: makeApi, deepMerge: deepMerge, encode: encode, decode: decode };
})();
