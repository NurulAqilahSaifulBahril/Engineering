'use strict';

const { app, BrowserWindow, Menu, protocol, net, shell, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');

// Serve the page over app:// instead of file:// so it has a stable origin:
// saved drafts in localStorage survive app updates and reinstalls to another folder.
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://om`;

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}]);

let mainWindow = null;

function resolveAsset(urlPath){
  // Map app://om/<file> onto the app directory, refusing anything that climbs out of it.
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '') || 'index.html';
  const full = path.resolve(__dirname, rel);
  if(full !== __dirname && !full.startsWith(__dirname + path.sep)) return null;
  return full;
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
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
  const template = [
    { label: 'File', submenu: [
      { label: 'Print / Save as PDF…', accelerator: 'CmdOrCtrl+P', click: ()=> mainWindow && mainWindow.webContents.print() },
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
  protocol.handle(SCHEME, req => {
    const file = resolveAsset(new URL(req.url).pathname);
    if(!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  buildMenu();
  createWindow();
  setupUpdates();

  app.on('activate', ()=>{ if(BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', ()=>{ if(process.platform !== 'darwin') app.quit(); });
