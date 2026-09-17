// preload.js
//
// Runs in a special context that can see both the renderer's `window`
// and a limited set of Node/Electron APIs. Nothing to expose yet -
// this file exists now so contextIsolation/nodeIntegration are locked
// down from the very first commit, the same security posture
// Initiative Tracker uses, rather than being retrofitted later. Real
// entries (map save/load, and eventually the IT sync bridge) get added
// here the same way Initiative Tracker's encounter save/load did.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),
  onConnectionStatus: (callback) => {
    ipcRenderer.on('connection-status', (event, payload) => callback(payload));
  },
});
