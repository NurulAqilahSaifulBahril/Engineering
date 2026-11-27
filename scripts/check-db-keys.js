// Release check: the bundled NUrul_DB keys must actually connect, so a wrong or blank
// secret stops the build instead of shipping an installer that cannot share data.
const fs = require('node:fs'), path = require('node:path');
const { parseEnv, hasKeys, createStore } = require('../om-db');

const env = parseEnv(fs.readFileSync(path.join(__dirname, '..', 'bundled', 'om-db.env'), 'utf8'));
if (!hasKeys(env)) { console.error('check-db-keys: bundled/om-db.env has no NUrul_DB keys'); process.exit(1); }
createStore(env).ping()
  .then(() => console.log('check-db-keys: NUrul_DB connection OK'))
  .catch(e => { console.error('check-db-keys: NUrul_DB rejected the keys - ' + (e.message || e)); process.exit(1); });
