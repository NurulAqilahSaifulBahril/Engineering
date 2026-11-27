// Desktop-app stand-in for the Claude runtime the dashboard was written for.
// index.html asks for claude.use('db' | 'user' | 'assets' | 'sample'). Here 'db' and 'assets'
// are backed by NUrul_DB through the main process (window.__omBridge), when this PC is connected;
// otherwise use() returns null and the page keeps saving on this device, as before.
// Served into index.html by main.js; index.html itself is unchanged.
(function () {
  'use strict';
  const B = window.__omBridge;
  if (!B || window.claude) return;

  const POLL_MS = 15000;
  const clone = d => JSON.parse(JSON.stringify(d === undefined ? null : d));
  const cols = {};   // collection -> { subs:Set, stamp, ok, timer, busy }

  function snapshot(docs) {
    return {
      docs: docs.map(d => ({ id: d.id, exists: true, data: () => clone(d.data) })),
      get size() { return docs.length; },
      get empty() { return !docs.length; },
    };
  }

  async function refresh(c, force) {
    const st = cols[c];
    if (!st || !st.subs.size) return;
    if (st.busy) { st.again = st.again || force; return; }
    st.busy = true;
    try {
      const stamp = await B.call('stamp', c);
      if (force || stamp !== st.stamp) {
        const docs = await B.call('list', c);
        st.stamp = stamp; st.ok = true;
        const snap = snapshot(docs);
        st.subs.forEach(s => { try { s.next(snap); } catch (e) { console.error(e); } });
      }
    } catch (e) {
      console.error('[om-db]', c, e && e.message);
      // Only the first load reports an error (the page then falls back to local storage).
      // Later network blips are retried quietly on the next poll.
      if (!st.ok) st.subs.forEach(s => { try { s.error && s.error(e); } catch {} });
    } finally {
      st.busy = false;
      if (st.again !== undefined) { const f = st.again; st.again = undefined; refresh(c, f); }
    }
  }

  function subscribe(c, next, error) {
    const st = cols[c] || (cols[c] = { subs: new Set() });
    const s = { next, error };
    st.subs.add(s);
    if (!st.timer) st.timer = setInterval(() => refresh(c, false), POLL_MS);
    refresh(c, true);
    return () => { st.subs.delete(s); if (!st.subs.size) { clearInterval(st.timer); st.timer = null; } };
  }
  const changed = c => { if (cols[c]) refresh(c, true); };
  window.addEventListener('focus', () => Object.keys(cols).forEach(c => refresh(c, false)));

  function docRef(c, id) {
    return {
      id,
      async get() { const d = await B.call('get', c, id); return { id, exists: !!d, data: () => clone(d) }; },
      async set(data) { await B.call('set', c, id, clone(data)); changed(c); },
      async update(patch) { await B.call('update', c, id, clone(patch)); changed(c); },
      async delete() { await B.call('remove', c, id); changed(c); },
    };
  }

  const db = {
    collection(c) {
      return {
        onSnapshot: (next, error) => subscribe(c, next, error),
        async add(data) { const id = await B.call('add', c, clone(data)); changed(c); return docRef(c, id); },
        doc: id => docRef(c, id),
      };
    },
    doc(path) { const i = String(path).indexOf('/'); return docRef(path.slice(0, i), path.slice(i + 1)); },
  };

  const blobToBase64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  const assets = {
    async upload(blob) { return { id: await B.call('putBlob', blob.type || 'application/octet-stream', await blobToBase64(blob)) }; },
  };

  let infoP = null;
  const info = () => infoP || (infoP = B.info());

  window.claude = {
    async use(name) {
      const i = await info();
      if (name === 'user') {
        return {
          id: async () => i.me || '',
          profiles: async ids => Object.fromEntries((ids || []).map(x => [x, { name: x }])),
        };
      }
      if (!i.connected) return null;
      if (name === 'db') return db;
      if (name === 'assets') return assets;
      return null;   // 'sample' (Claude reading files) is not available in the desktop app
    },
  };
})();
