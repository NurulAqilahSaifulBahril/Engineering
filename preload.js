'use strict';
// Narrow bridge to the main process. Only plain data crosses it; the database key stays in main.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__omBridge', {
  info: () => ipcRenderer.invoke('om:info'),
  call: (op, ...args) => ipcRenderer.invoke('om:db', op, args),
});
