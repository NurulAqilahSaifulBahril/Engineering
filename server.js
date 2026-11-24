const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseEnv, searchInvoices, staffSignIn } = require('./invoice-lookup');

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
}).listen(PORT, () => console.log(`Eternalgy portal running at http://localhost:${PORT}`));
