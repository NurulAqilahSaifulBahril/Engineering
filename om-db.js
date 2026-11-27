'use strict';
// NUrul_DB storage for the O&M dashboard. Runs in the Electron main process only: the page
// never sees the key and can only reach the fixed operations below, never arbitrary SQL.
//
// Tables (created on first use, never touches any other table):
//   public.om_docs  — one row per record: (collection, id) -> data jsonb
//   public.om_blobs — pictures and attachments referenced by the page as /_blob/<id>

const crypto = require('node:crypto');

// The only collections the page may read or write.
const COLLECTIONS = new Set(['reports', 'issues', 'rectify', 'drawings', 'loadprofiles', 'manuals', 'tcjobs']);
const KEYS = ['NURUL_PG_PROXY_URL', 'NURUL_PG_PROXY_DATABASE', 'NURUL_PG_PROXY_TOKEN'];

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
const hasKeys = env => KEYS.every(k => env && env[k]);

function createStore(env) {
  if (!hasKeys(env)) return null;
  const { NURUL_PG_PROXY_URL: url, NURUL_PG_PROXY_DATABASE: dbName, NURUL_PG_PROXY_TOKEN: token } = env;

  async function q(sql, params = []) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_name: dbName, sql, params }),
      signal: AbortSignal.timeout(20000),
    });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
    return j.rows || [];
  }

  let ready = null;
  const ensure = () => ready || (ready = (async () => {
    await q(`create table if not exists public.om_docs (
      collection text not null, id text not null, data jsonb not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      updated_by text, primary key (collection, id))`);
    await q(`create table if not exists public.om_blobs (
      id text primary key, mime text not null, data text not null,
      created_at timestamptz not null default now(), created_by text)`);
  })().catch(e => { ready = null; throw e; }));

  const col = c => { if (!COLLECTIONS.has(c)) throw new Error('Unknown collection: ' + c); return c; };
  const docId = id => { const s = String(id || ''); if (!/^[A-Za-z0-9_-]{1,80}$/.test(s)) throw new Error('Bad id'); return s; };
  const obj = d => { if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Bad data'); return JSON.stringify(d); };
  const newId = () => crypto.randomBytes(15).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || ('x' + Date.now());

  return {
    async ping() { await ensure(); await q('select 1'); return true; },
    // Cheap change check: count + latest update. The page only refetches a collection when it moves.
    async stamp(c) {
      await ensure();
      const [r] = await q('select count(*)::int as n, coalesce(max(updated_at), \'epoch\')::text as t from public.om_docs where collection = $1', [col(c)]);
      return r.n + '|' + r.t;
    },
    async list(c) {
      await ensure();
      const rows = await q('select id, data from public.om_docs where collection = $1 order by created_at', [col(c)]);
      return rows.map(r => ({ id: r.id, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
    },
    async get(c, id) {
      await ensure();
      const rows = await q('select data from public.om_docs where collection = $1 and id = $2', [col(c), docId(id)]);
      if (!rows.length) return null;
      return typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    },
    async set(c, id, data, who) {
      await ensure();
      await q(`insert into public.om_docs (collection, id, data, updated_by) values ($1, $2, $3::jsonb, $4)
               on conflict (collection, id) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`,
        [col(c), docId(id), obj(data), String(who || '').slice(0, 100)]);
      return true;
    },
    async add(c, data, who) {
      const id = newId();
      await this.set(c, id, data, who);
      return id;
    },
    // Field-level merge done in the database, so two people editing the same record
    // at once each keep their own changes.
    async update(c, id, patch, who) {
      await ensure();
      const rows = await q(`update public.om_docs set data = data || $3::jsonb, updated_at = now(), updated_by = $4
                            where collection = $1 and id = $2 returning id`,
        [col(c), docId(id), obj(patch), String(who || '').slice(0, 100)]);
      if (!rows.length) throw new Error('Record not found (it may have been deleted)');
      return true;
    },
    async remove(c, id) {
      await ensure();
      await q('delete from public.om_docs where collection = $1 and id = $2', [col(c), docId(id)]);
      return true;
    },
    async putBlob(mime, base64, who) {
      await ensure();
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(String(mime || ''))) mime = 'application/octet-stream';
      if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error('Bad file data');
      if (base64.length > 14 * 1024 * 1024) throw new Error('File is too large (over 10 MB)');
      const id = 'b' + crypto.randomBytes(12).toString('hex');
      await q('insert into public.om_blobs (id, mime, data, created_by) values ($1, $2, $3, $4)', [id, mime, base64, String(who || '').slice(0, 100)]);
      return id;
    },
    async getBlob(id) {
      await ensure();
      if (!/^b[0-9a-f]{24}$/.test(String(id))) return null;
      const rows = await q('select mime, data from public.om_blobs where id = $1', [id]);
      return rows.length ? { mime: rows[0].mime, data: Buffer.from(rows[0].data, 'base64') } : null;
    },
  };
}

module.exports = { parseEnv, hasKeys, createStore, COLLECTIONS, KEYS };
