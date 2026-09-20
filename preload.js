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

  // Initiative Tracker remote puppeting - see spawn-tab.js's "puppeted"
  // mode for what each of these does on the renderer side, and main.js
  // for the window move/resize/focus and pairing-socket messages
  // underneath.
  requestOpenImport: () => ipcRenderer.invoke('remote-open-import'),
  requestOpenPackage: () => ipcRenderer.invoke('remote-open-package'),
  requestOpenEditTemplate: (templateId) => ipcRenderer.invoke('remote-open-edit-template', templateId),
  requestOpenEditPackage: (packageId) => ipcRenderer.invoke('remote-open-edit-package', packageId),
  requestOpenDeletePackage: (packageId) => ipcRenderer.invoke('remote-open-delete-package', packageId),
  requestOpenAdvancedCreate: (draft) => ipcRenderer.invoke('remote-open-advanced-create', draft),
  requestCreateTemplate: (data) => ipcRenderer.invoke('remote-create-template', data),
  requestDeleteTemplate: (templateId) => ipcRenderer.invoke('remote-delete-template', templateId),
  onBestiarySync: (callback) => {
    ipcRenderer.on('bestiary-sync', (event, templates) => callback(templates));
  },
  // One-shot pull of whatever IT last pushed - see main.js's
  // lastBestiaryTemplates for why this exists (a load-order race that
  // can otherwise drop the very first sync silently).
  getBestiarySync: () => ipcRenderer.invoke('get-bestiary-sync'),

  // Package support - see spawn-tab.js's drag wiring for when each of
  // these actually fires.
  requestToggleExpand: (packageId) => ipcRenderer.invoke('remote-toggle-expand', packageId),
  requestReorderTemplate: (draggedId, targetId, insertBefore) =>
    ipcRenderer.invoke('remote-reorder-template', { draggedId, targetId, insertBefore }),
  requestAddToPackage: (templateId, packageId) =>
    ipcRenderer.invoke('remote-add-to-package', { templateId, packageId }),
  requestRemoveFromPackage: (templateId, packageId) =>
    ipcRenderer.invoke('remote-remove-from-package', { templateId, packageId }),

  // Creature tray - see tray.js.
  requestSpawnEntity: (templateId) => ipcRenderer.invoke('remote-spawn-entity', templateId),
  requestRemoveEntity: (entityId) => ipcRenderer.invoke('remote-remove-entity', entityId),
  requestRenameEntity: (entityId, name) => ipcRenderer.invoke('remote-rename-entity', entityId, name),
  onEntitySync: (callback) => {
    ipcRenderer.on('entity-sync', (event, entities) => callback(entities));
  },
  getEntitySync: () => ipcRenderer.invoke('get-entity-sync'),
});
