const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseEnv, searchInvoices, invoicePayments, staffSignIn, kvGet, kvSet } = require('./invoice-lookup');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;

// Database settings live in .env (git-ignored, never packaged, never served).
// The proxy keys stay on this server; the page only ever sees the looked-up values.
let ENV = {};
try { ENV = parseEnv(fs.readFileSync(path.join(ROOT, '.env'), 'utf8')); }
catch (e) { /* no .env: invoice search reports itself unavailable */ }

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Shared portal data, same table the desktop app uses (NUrul_DB public.portal_kv), so the browser
// version and the installed app always show the same accounts and records. Only the portal's own
// state key is served, and only to this computer (the server listens on 127.0.0.1).
const SHARED_KEYS = new Set(['solarops_state_v1']);
const kvEnabled = () => !!(ENV.NURUL_PG_PROXY_URL && ENV.NURUL_PG_PROXY_DATABASE && ENV.NURUL_PG_PROXY_TOKEN);
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/api/invoices') {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    searchInvoices(ENV, q).then(r => sendJson(res, r.status, r.body));
    return;
  }
  if (rel === '/api/invoice-payments' && req.method === 'POST') {
    readBody(req, 1024 * 1024).then(text => {
      const b = JSON.parse(text || '{}');
      return invoicePayments(ENV, b.numbers, b.names).then(r => sendJson(res, r.status, r.body));
    }).catch(() => sendJson(res, 400, { error: 'Bad request' }));
    return;
  }
  if (rel === '/api/kv/enabled') { sendJson(res, 200, { enabled: kvEnabled() }); return; }
  if (rel === '/api/kv') {
    if (!kvEnabled()) { sendJson(res, 503, { error: 'NUrul_DB is not set up on this PC.' }); return; }
    if (req.method === 'GET') {
      const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
      if (!SHARED_KEYS.has(key)) { sendJson(res, 403, { error: 'Unknown key' }); return; }
      kvGet(ENV, key).then(v => sendJson(res, 200, { value: v })).catch(() => sendJson(res, 502, { error: 'NUrul_DB unreachable' }));
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 40 * 1024 * 1024).then(text => {
        const { key, value } = JSON.parse(text || '{}');
        if (!SHARED_KEYS.has(key) || typeof value !== 'string') { sendJson(res, 400, { error: 'Bad request' }); return; }
        return kvSet(ENV, key, value, 'browser:' + require('os').userInfo().username).then(() => sendJson(res, 200, { ok: true }));
      }).catch(() => sendJson(res, 502, { error: 'Save failed' }));
      return;
    }
    sendJson(res, 405, { error: 'Method not allowed' }); return;
  }
  if (rel === '/api/staff-signin') {
    const p = new URL(req.url, 'http://x').searchParams.get('phone') || '';
    staffSignIn(ENV, p).then(r => sendJson(res, r.status, r.body));
    return;
  }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(ROOT, '.' + rel);
  // Stay inside the folder and never serve dotfiles/dot-folders (.env, .git, .claude).
  if (!file.startsWith(ROOT) || path.relative(ROOT, file).split(path.sep).some(p => p.startsWith('.'))) {
    res.writeHead(403).end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Eternalgy portal running at http://localhost:${PORT}`));
