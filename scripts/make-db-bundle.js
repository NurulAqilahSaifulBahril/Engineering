// Writes bundled/om-db.env (only the three NUrul_DB keys), which electron-builder ships
// inside the installer (extraResources) so installed PCs connect to NUrul_DB with no setup.
//
// Keys come from environment variables (the release workflow sets them from Actions
// secrets), else from a .env in this folder or the folder above (local builds).
// In CI a missing or blank key fails the build. Locally it writes a key-free file, and
// the installed app then saves on each PC until File → Database Connection… is used.
const fs = require('node:fs'), path = require('node:path');
const { parseEnv, hasKeys, KEYS } = require('../om-db');

const root = path.join(__dirname, '..');
let env = Object.fromEntries(KEYS.map(k => [k, (process.env[k] || '').trim()]));
if (!hasKeys(env)) {
  for (const p of [path.join(root, '.env'), path.join(root, '..', '.env')]) {
    try { const e = parseEnv(fs.readFileSync(p, 'utf8')); if (hasKeys(e)) { env = e; break; } } catch {}
  }
}

const out = path.join(root, 'bundled', 'om-db.env');
fs.mkdirSync(path.dirname(out), { recursive: true });
if (hasKeys(env)) {
  fs.writeFileSync(out, KEYS.map(k => `${k}=${env[k]}`).join('\n') + '\n');
  console.log('make-db-bundle: NUrul_DB keys bundled');
} else if (process.env.CI) {
  console.error('make-db-bundle: missing or blank ' + KEYS.join(' / ') + ' - add them under Settings > Secrets and variables > Actions');
  process.exit(1);
} else {
  fs.writeFileSync(out, '# No NUrul_DB keys bundled in this build\n');
  console.log('make-db-bundle: no keys found, building without NUrul_DB');
}
