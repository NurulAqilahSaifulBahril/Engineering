'use strict';

// Invoice lookup shared by server.js (localhost) and main.js (desktop app).
// prod_main: invoice no., customer, phone, email, address, agent, amount, kWp.
// NUrul_DB: installation date, supervisor, wiring and installer teams.
// Invoice search only SELECTs; the one write path is the portal_kv table at the bottom.
// The proxy keys never leave the process that calls this.

// Parses a KEY=value file (.env style).
function parseEnv(text) {
  const env = {};
  String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
  return env;
}

// System size in kWp = panels × watts ÷ 1000. Panel count and wattage come from the package text
// first (e.g. "20X 620W Jinko Tiger Neo …"), then the invoice's panel_qty / panel_rating columns —
// the same order as the Installation System (lib/source-api.ts, lib/panel-utils.ts). Falls back to
// the SEDA registration's system size.
const NOT_PANEL = /\b(inverter|battery|seda|tnb|smart\s*meter|skylift|mounting|cable|works|design|surveying|application)\b/i;
function panelLine(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.find(l => /\b(panel|panels|jinko|jinkosolar|astronergy|longi|trina|ja\s*solar|canadian\s*solar|risen|topcon|bi-?facial|tiger\s*neo)\b/i.test(l) && !NOT_PANEL.test(l))
      || lines.find(l => /^\(?\d+(?:\+\d+)?\)?\s*(?:[xX×]|pcs|panels?\b)/i.test(l) && !NOT_PANEL.test(l))
      || lines[0] || '';
}
function systemKwp(x) {
  const line = panelLine(x.package_text);
  const qm = line.match(/^(\d+)\s*[xX×]/), wm = line.match(/^\d+\s*[xX×]\s*(\d{3,4})\s*W(?:p|att)?\b/i);
  const qty = qm ? Number(qm[1]) : Number(x.panel_qty) || 0;
  const watt = Number(x.panel_rating) || (wm ? Number(wm[1]) : 0);
  if (qty > 0 && watt > 0) return Math.round(qty * watt / 10) / 100;
  const seda = Number(x.seda_kwp);
  return seda > 0 ? seda : null;
}

async function proxyQuery(url, db, token, sql, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ db_name: db, sql, params }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.rows || [];
}

// Installation dates live in NUrul_DB (the Installation System's installation_jobs), keyed to the
// prod_main invoice by source_invoice_id = invoice bubble_id (some rows use the numeric id).
// Supervisor and teams come from the Installation System's installation groups
// (installation_ops_state.state.groups[]: jobIds = those same invoice ids, supervisors[], wiringTeam,
// wiringMembers[], installationTeam, installationDate). A job rescheduled into a later group keeps
// the latest group. Returns { [bubble_id or id]: { date, supervisor, wiringTeam, installerTeam } }.
// If NUrul_DB is unreachable these are just left blank.
async function installationInfo(env, rows) {
  const { NURUL_PG_PROXY_URL: url, NURUL_PG_PROXY_DATABASE: db, NURUL_PG_PROXY_TOKEN: token } = env;
  const ids = [...new Set(rows.flatMap(x => [x.bubble_id, x.invoice_id]).filter(Boolean).map(String))];
  if (!url || !db || !token || !ids.length) return {};
  const out = {};
  const at = id => (out[id] = out[id] || { date: '', supervisor: '', wiringTeam: '', installerTeam: '' });
  const clean = v => (typeof v === 'string' ? v.trim() : '');
  const [jobs, groups] = await Promise.all([
    proxyQuery(url, db, token,
      'select source_invoice_id, installation_date::text as d from public.installation_jobs ' +
      'where source_invoice_id = any($1::text[]) and installation_date is not null', [ids])
      .catch(e => { console.warn('Installation date lookup failed:', e.message); return []; }),
    proxyQuery(url, db, token,
      "select g as grp from public.installation_ops_state s, jsonb_array_elements(coalesce(s.state->'groups', '[]'::jsonb)) g " +
      "where jsonb_typeof(g->'jobIds') = 'array' and (g->'jobIds') ?| $1::text[]", [ids])
      .catch(e => { console.warn('Installation group lookup failed:', e.message); return []; }),
  ]);
  jobs.forEach(x => { at(x.source_invoice_id).date = String(x.d).slice(0, 10); });
  const latest = {};
  groups.map(x => (typeof x.grp === 'string' ? JSON.parse(x.grp) : x.grp)).forEach(g => {
    const gDate = clean(g.installationDate).slice(0, 10);
    const sups = (Array.isArray(g.supervisors) ? g.supervisors : [g.supervisor]).map(clean).filter(Boolean);
    const wiring = (Array.isArray(g.wiringMembers) ? g.wiringMembers.map(clean).filter(Boolean) : []);
    (g.jobIds || []).filter(id => ids.includes(id)).forEach(id => {
      if (latest[id] && latest[id] > gDate) return;   // keep the latest group for this job
      latest[id] = gDate;
      const info = at(id);
      info.supervisor = sups.join(', ');
      info.wiringTeam = (wiring.length ? wiring : [clean(g.wiringTeam)].filter(Boolean)).join('\n');
      info.installerTeam = clean(g.installationTeam);
      if (!info.date && gDate) info.date = gDate;   // group date when the job row has none
    });
  });
  return out;
}

// Invoice search: invoice number or customer name. Read-only, max 20 rows.
// Returns { status, body } — body is { source, invoices } or { error }.
async function searchInvoices(env, rawQuery) {
  const { PG_PROXY_URL: url, PG_PROXY_DATABASE: db, PG_PROXY_TOKEN: token } = env || {};
  if (!url || !db || !token) return { status: 503, body: { error: 'Invoice search is not set up on this PC.', notConfigured: true } };
  const q = String(rawQuery || '').trim().slice(0, 80);
  if (q.length < 2) return { status: 200, body: { source: db, invoices: [] } };
  // Joins follow the Installation System's lib/source-api.ts (agent can sit on any of three links).
  const sql = [
    'select i.bubble_id, i.id::text as invoice_id, i.invoice_number, c.name as customer_name, i.total_amount,',
    '  c.phone,',
    "  coalesce(nullif(trim(s.email), ''), nullif(trim(c.email), '')) as email,",
    "  coalesce(nullif(trim(s.installation_address), ''),",
    "    nullif(concat_ws(', ', nullif(trim(c.address), ''), nullif(trim(concat_ws(' ', nullif(trim(c.postcode), ''), nullif(trim(c.city), ''))), ''), nullif(trim(c.state), '')), '')) as project_address,",
    '  coalesce(a.name, user_agent.name, agent_user.name) as agent_name,',
    '  i.panel_qty, i.panel_rating, pkg.description as package_text,',
    '  coalesce(nullif(s.system_size_in_form_kwp, 0), nullif(s.system_size, 0)) as seda_kwp',
    'from public.invoice i',
    // the package's own line item (earliest is_a_package row), as the Installation System reads it
    'left join lateral (select ii.description from public.invoice_item ii',
    '  where ii.linked_invoice = i.bubble_id and ii.is_a_package = true',
    '  order by ii.sort nulls last, ii.id limit 1) pkg on true',
    'left join public.customer c on c.customer_id = i.linked_customer',
    'left join public.agent a on a.linked_user_login = i.linked_agent or a.bubble_id = i.linked_agent',
    'left join public."user" agent_user on agent_user.bubble_id = i.linked_agent',
    'left join public.agent user_agent on user_agent.bubble_id = agent_user.linked_agent_profile',
    'left join public.seda_registration s on s.bubble_id = i.linked_seda_registration',
    'where coalesce(i.is_deleted, false) = false',
    "  and (i.invoice_number ilike $1 or c.name ilike $1)",
    'order by i.created_date desc nulls last',
    'limit 20',
  ].join('\n');
  try {
    const rows = await proxyQuery(url, db, token, sql, ['%' + q.replace(/[\\%_]/g, '\\$&') + '%']);
    const install = await installationInfo(env, rows);
    return { status: 200, body: {
      source: db,
      invoices: rows.map(x => { const inst = install[x.bubble_id] || install[x.invoice_id] || {}; return {
        installationDate: inst.date || '',
        supervisor: inst.supervisor || '',
        wiringTeam: inst.wiringTeam || '',
        installerTeam: inst.installerTeam || '',
        invoiceNumber: x.invoice_number || '',
        customerName: (x.customer_name || '').trim(),
        phone: (x.phone || '').trim(),
        email: (x.email || '').trim(),
        projectAddress: (x.project_address || '').trim(),
        agent: (x.agent_name || '').trim(),
        projectAmount: x.total_amount == null || x.total_amount === '' ? null : Number(x.total_amount),
        systemKwp: systemKwp(x),
      }; }),
    } };
  } catch (e) {
    return { status: 502, body: { error: 'Invoice search failed: ' + e.message } };
  }
}


// Shared portal data in NUrul_DB: one table of its own (public.portal_kv). Never touches the
// Installation System's tables. Keys are the portal's storage keys; values are the JSON text.
let kvReady = false;
function nurul(env) {
  const { NURUL_PG_PROXY_URL: url, NURUL_PG_PROXY_DATABASE: db, NURUL_PG_PROXY_TOKEN: token } = env || {};
  if (!url || !db || !token) throw new Error('NUrul_DB is not set up on this PC.');
  return [url, db, token];
}
async function kvEnsure(env) {
  if (kvReady) return;
  await proxyQuery(...nurul(env),
    'create table if not exists public.portal_kv (key text primary key, value text not null, ' +
    'updated_at timestamptz not null default now(), updated_by text)', []);
  kvReady = true;
}
async function kvGet(env, key) {
  await kvEnsure(env);
  const rows = await proxyQuery(...nurul(env), 'select value from public.portal_kv where key = $1', [String(key).slice(0, 200)]);
  return rows.length ? rows[0].value : null;
}
async function kvSet(env, key, value, who) {
  await kvEnsure(env);
  await proxyQuery(...nurul(env),
    'insert into public.portal_kv (key, value, updated_by) values ($1, $2, $3) ' +
    'on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by',
    [String(key).slice(0, 200), String(value), String(who || '').slice(0, 100)]);
  return true;
}

// Sign-in by phone number against the staff table (NUrul_DB public."user"). Runs in the server / Electron
// main process only; the page gets back just { allowed, name } — never the token or any other column.
// Only these main_department values may sign in (a person can list several, separated by ";").
const STAFF_SIGNIN_DEPARTMENTS = ['Engineering Dept', 'Project Department', 'Finance Dept', 'SEDA Administration', 'Sales Dept'];
async function staffSignIn(env, rawPhone) {
  let digits = String(rawPhone || '').replace(/\D+/g, '');
  if (digits.length < 9 || digits.length > 13) return { status: 200, body: { allowed: false, reason: 'not-found' } };
  let args;
  try { args = nurul(env); } catch (e) { return { status: 503, body: { allowed: false, reason: 'not-configured' } }; }
  try {
    const rows = await proxyQuery(...args,
      "select name, main_department, access_level::text as access_level from public.\"user\" " +
      "where contact is not null and length(regexp_replace(contact, '\\D', '', 'g')) >= 9 " +
      "and right(regexp_replace(contact, '\\D', '', 'g'), 9) = $1 limit 10",
      [digits.slice(-9)]);
    if (!rows.length) return { status: 200, body: { allowed: false, reason: 'not-found' } };
    const ok = rows.find(r => {
      const depts = String(r.main_department || '').split(';').map(s => s.trim().toLowerCase()).filter(Boolean);
      const inDept = depts.some(d => STAFF_SIGNIN_DEPARTMENTS.some(a => a.toLowerCase() === d));
      const blocked = /\b(blocked|pending)\b/i.test(String(r.access_level || ''));
      return inDept && !blocked && String(r.name || '').trim();
    });
    if (!ok) return { status: 200, body: { allowed: false, reason: 'not-allowed' } };
    return { status: 200, body: { allowed: true, name: String(ok.name).trim().slice(0, 100) } };
  } catch (e) {
    return { status: 502, body: { allowed: false, reason: 'error' } };
  }
}

module.exports = { parseEnv, searchInvoices, kvGet, kvSet, staffSignIn };
