'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the portal page and Electron. Deliberately tiny:
// the page can learn that an update is ready and ask to restart, and ask the
// main process for invoice search results (the database keys stay in main).
contextBridge.exposeInMainWorld('portalData', {
  searchInvoices: (q)=> ipcRenderer.invoke('invoices:search', String(q || '').slice(0, 80))
});
contextBridge.exposeInMainWorld('portalUpdates', {
  onUpdateReady: (callback)=>{
    ipcRenderer.on('update:ready', (_event, info)=> callback(info));
  },
  restartToUpdate: ()=> ipcRenderer.invoke('update:restart')
});
