'use strict';

const { app, BrowserWindow, Menu, protocol, net, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const omdb = require('./om-db');

// Serve the page over app:// instead of file:// so it has a stable origin:
// saved drafts in localStorage survive app updates and reinstalls to another folder.
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://om`;

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

let mainWindow = null;

/* ---------------------------------------------------------
   SETTINGS + NUrul_DB CONNECTION
   The connection file (NURUL_PG_PROXY_URL / _DATABASE / _TOKEN) is read from, in order:
     1. <userData>/om-db.env   — imported on this PC via File → Database Connection…
     2. <resources>/om-db.env  — bundled in the installer, if the release includes one
   Without either, the app saves on this device only, exactly as before.
--------------------------------------------------------- */
const userFile = name => path.join(app.getPath('userData'), name);
const importedEnvPath = () => userFile('om-db.env');
const bundledEnvPath = () => path.join(process.resourcesPath || '', 'om-db.env');

function readSettings(){ try { return JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8')); } catch { return {}; } }
function writeSettings(s){ fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(userFile('settings.json'), JSON.stringify(s, null, 2)); }
const myName = () => readSettings().name || os.userInfo().username || '';

let store = null, storeSource = null;
function loadStore(){
  store = null; storeSource = null;
  for(const [p, src] of [[importedEnvPath(), 'imported'], [bundledEnvPath(), 'bundled']]){
    try {
      const env = omdb.parseEnv(fs.readFileSync(p, 'utf8'));
      if(omdb.hasKeys(env)){ store = omdb.createStore(env); storeSource = src; return; }
    } catch {}
  }
}

const DB_OPS = {
  stamp: (c) => store.stamp(c),
  list: (c) => store.list(c),
  get: (c, id) => store.get(c, id),
  set: (c, id, d) => store.set(c, id, d, myName()),
  add: (c, d) => store.add(c, d, myName()),
  update: (c, id, d) => store.update(c, id, d, myName()),
  remove: (c, id) => store.remove(c, id),
  putBlob: (mime, b64) => store.putBlob(mime, b64, myName()),
};

function setupDbIpc(){
  ipcMain.handle('om:info', ()=> ({ connected: !!store, me: myName() }));
  ipcMain.handle('om:db', async (_e, op, args)=>{
    if(!store) throw new Error('NUrul_DB is not connected on this PC.');
    const fn = DB_OPS[op];
    if(!fn) throw new Error('Unknown operation');
    return fn(...(Array.isArray(args) ? args : []));
  });
}

/* ---------------------------------------------------------
   app:// FILES
   index.html is served with om-shim.js added, so the page finds its database.
   /_blob/<id> serves pictures stored in NUrul_DB, cached on disk after the first load.
--------------------------------------------------------- */
function resolveAsset(urlPath){
  // Map app://om/<file> onto the app directory, refusing anything that climbs out of it.
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const full = path.resolve(__dirname, rel);
  if(full !== __dirname && !full.startsWith(__dirname + path.sep)) return null;
  return full;
}

async function serveBlob(id){
  if(!/^b[0-9a-f]{24}$/.test(id)) return new Response('Not found', { status: 404 });
  const dir = userFile('blobs'), file = path.join(dir, id), meta = file + '.type';
  try { return new Response(fs.readFileSync(file), { headers: { 'Content-Type': fs.readFileSync(meta, 'utf8') } }); } catch {}
  if(!store) return new Response('Not connected', { status: 503 });
  try {
    const b = await store.getBlob(id);
    if(!b) return new Response('Not found', { status: 404 });
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, b.data); fs.writeFileSync(meta, b.mime); } catch {}
    return new Response(b.data, { headers: { 'Content-Type': b.mime } });
  } catch(e){
    return new Response('Could not load picture', { status: 502 });
  }
}

function setupProtocol(){
  protocol.handle(SCHEME, async req => {
    const p = new URL(req.url).pathname;
    if(p.startsWith('/_blob/')) return serveBlob(p.slice(7));
    const file = resolveAsset(p);
    if(!file) return new Response('Not found', { status: 404 });
    if(path.basename(file) === 'index.html'){
      const html = fs.readFileSync(file, 'utf8').replace(/<head>/i, '<head><script src="om-shim.js"></script>');
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

function createWindow(){
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Eternalgy O&M Dashboard',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });

  mainWindow.once('ready-to-show', ()=> mainWindow.show());
  mainWindow.loadURL(`${ORIGIN}/index.html`);

  // External links open in the real browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url })=>{
    if(/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url)=>{
    if(!url.startsWith(ORIGIN)){
      e.preventDefault();
      if(/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', ()=> { mainWindow = null; });
}

/* ---------------------------------------------------------
   FILE MENU: database connection and "your name"
--------------------------------------------------------- */
async function importConnection(){
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the NUrul_DB connection file',
    properties: ['openFile'],
    filters: [{ name: 'Connection file', extensions: ['env', 'txt'] }, { name: 'All files', extensions: ['*'] }]
  });
  if(r.canceled || !r.filePaths[0]) return;
  const text = fs.readFileSync(r.filePaths[0], 'utf8');
  const env = omdb.parseEnv(text);
  if(!omdb.hasKeys(env)){
    dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Not a connection file',
      message: 'This file does not contain the NUrul_DB connection.', detail: 'It needs ' + omdb.KEYS.join(', ') + '.' });
    return;
  }
  try { await omdb.createStore(env).ping(); }
  catch(e){
    dialog.showMessageBox(mainWindow, { type: 'error', title: 'Could not connect', message: 'NUrul_DB did not accept this connection.', detail: String(e.message || e) });
    return;
  }
  // Keep only the three keys this app needs.
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(importedEnvPath(), omdb.KEYS.map(k => `${k}=${env[k]}`).join('\n') + '\n');
  loadStore(); buildMenu();
  await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Connected', message: 'Connected to NUrul_DB.', detail: 'Records are now shared with everyone connected. Records saved on this PC before stay here and are not shown while connected.' });
  mainWindow && mainWindow.reload();
}

async function disconnect(){
  const { response } = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Disconnect',
    message: 'Disconnect this PC from NUrul_DB?', detail: 'The shared records stay in NUrul_DB. This PC goes back to saving on this device only.',
    buttons: ['Disconnect', 'Cancel'], defaultId: 1, cancelId: 1 });
  if(response !== 0) return;
  try { fs.unlinkSync(importedEnvPath()); } catch {}
  loadStore(); buildMenu();
  mainWindow && mainWindow.reload();
}

function askName(){
  // Small window with one text box: Electron has no built-in text prompt.
  return new Promise(resolve => {
    const w = new BrowserWindow({ parent: mainWindow, modal: true, width: 420, height: 210, resizable: false, minimizable: false, maximizable: false,
      title: 'Your name', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;margin:18px">
      <form onsubmit="location.hash='ok:'+encodeURIComponent(n.value);return false">
      <label>Your name (shown as “Logged by” on records you save)<br>
      <input id="n" value="${esc(myName())}" style="width:100%;padding:7px;margin:8px 0;font:inherit" autofocus></label>
      <button style="padding:6px 16px">Save</button> <button type="button" onclick="location.hash='cancel'" style="padding:6px 16px">Cancel</button></form>`;
    let done = false;
    const finish = v => { if(done) return; done = true; resolve(v); if(!w.isDestroyed()) w.close(); };
    w.webContents.on('did-navigate-in-page', (_e, url) => {
      const h = decodeURIComponent((url.split('#')[1] || ''));
      if(h.startsWith('ok:')) finish(h.slice(3).trim()); else if(h === 'cancel') finish(null);
    });
    w.on('closed', () => finish(null));
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}
async function setName(){
  const n = await askName();
  if(n == null) return;
  const s = readSettings(); s.name = n.slice(0, 60); writeSettings(s);
  buildMenu();
  mainWindow && mainWindow.reload();
}

/* Auto-update from GitHub Releases (public repo, no token needed).
   Downloads in the background, then asks before restarting so an
   unsaved report is never lost to a surprise restart. */
let manualCheck = false;

function setupUpdates(){
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or it will install the next time you close the app.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if(response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on('update-not-available', ()=>{
    if(!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox(mainWindow, { type: 'info', title: 'No update available', message: `You're on the latest version (${app.getVersion()}).` });
  });

  autoUpdater.on('error', err => {
    // Being offline is normal; only report it when the user asked.
    console.error('[updater]', err && (err.message || err));
    if(!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Update check failed', message: 'Could not reach the update server. Check your connection and try again.' });
  });

  if(app.isPackaged) autoUpdater.checkForUpdates().catch(()=>{});
}

function checkForUpdatesManually(){
  if(!app.isPackaged){
    dialog.showMessageBox(mainWindow, { type: 'info', title: 'Updates', message: 'Update checks only run in the installed app.' });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(()=>{});
}

function buildMenu(){
  const dbLabel = store ? `NUrul_DB: connected${storeSource === 'bundled' ? ' (built in)' : ''}` : 'NUrul_DB: not connected (saving on this PC)';
  const template = [
    { label: 'File', submenu: [
      { label: 'Print / Save as PDF…', accelerator: 'CmdOrCtrl+P', click: ()=> mainWindow && mainWindow.webContents.print() },
      { type: 'separator' },
      { label: dbLabel, enabled: false },
      { label: 'Database Connection…', click: importConnection },
      { label: 'Disconnect from NUrul_DB', visible: storeSource === 'imported', click: disconnect },
      { label: `Your name: ${myName() || '(not set)'}…`, click: setName },
      { type: 'separator' },
      { role: 'quit' }
    ]},
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
      { role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus', visible: false },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]},
    { label: 'Help', submenu: [
      { label: 'Check for Updates…', click: checkForUpdatesManually },
      { label: `Version ${app.getVersion()}`, enabled: false }
    ]}
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(()=>{
  loadStore();
  setupDbIpc();
  setupProtocol();
  buildMenu();
  createWindow();
  setupUpdates();

  app.on('activate', ()=>{ if(BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', ()=>{ if(process.platform !== 'darwin') app.quit(); });
