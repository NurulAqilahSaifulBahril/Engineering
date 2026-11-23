// Copies only the database keys from .env into bundled/portal-db.env, which
// electron-builder ships inside the installer (extraResources).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const lines = fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)
  .filter(l => /^(NURUL_)?PG_PROXY_(URL|DATABASE|TOKEN)=/.test(l));
if (lines.length < 6) { console.error('make-db-bundle: .env is missing PG_PROXY_* / NURUL_PG_PROXY_* keys'); process.exit(1); }
fs.mkdirSync(path.join(root, 'bundled'), { recursive: true });
fs.writeFileSync(path.join(root, 'bundled', 'portal-db.env'), lines.join('\n') + '\n');
console.log('make-db-bundle: wrote', lines.length, 'keys');
