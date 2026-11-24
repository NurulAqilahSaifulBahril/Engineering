// Fails the build unless BOTH databases answer with the keys in .env (so an installer can never ship
// with blank or wrong keys). Prints only which database failed, never any key value.
const fs = require('fs'), path = require('path');
const env = {};
fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(l => {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
});
async function check(label, prefix) {
  const url = env[prefix + 'URL'], db = env[prefix + 'DATABASE'], token = env[prefix + 'TOKEN'];
  const missing = ['URL', 'DATABASE', 'TOKEN'].filter(k => !env[prefix + k]).map(k => prefix + k);
  if (missing.length) return console.error('FAIL ' + label + ': blank or missing secret(s): ' + missing.join(', ')) || false;
  try {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ db_name: db, sql: 'select 1 as ok', params: [] }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return console.error('FAIL ' + label + ': the database refused these keys (HTTP ' + r.status + ')') || false;
    console.log('OK   ' + label + ': connected');
    return true;
  } catch (e) { return console.error('FAIL ' + label + ': could not reach the database (' + e.message + ')') || false; }
}
(async () => {
  const a = await check('prod_main (PG_PROXY_*)', 'PG_PROXY_');
  const b = await check('NUrul_DB (NURUL_PG_PROXY_*)', 'NURUL_PG_PROXY_');
  if (!(a && b)) { console.error('Database key check failed - fix the Actions secrets (Settings > Secrets and variables > Actions) and run again.'); process.exit(1); }
})();
