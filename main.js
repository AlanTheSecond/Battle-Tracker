// main.js
//
// The "main process" - the piece of the app with access to the operating
// system. Everything the user sees lives in the renderer process
// (renderer/index.html + app.js), which is just a webpage. Real
// ipcMain wiring starts here now with pairing status - map save/load
// and the rest of the sync contract will grow alongside real features,
// same as it did in Initiative Tracker.

const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const pairing = require('./pairing');

const APP_VERSION = require('./package.json').version;

let mainWindow = null;

// Same reasoning as Initiative Tracker: a second launch would otherwise
// silently fall back to an in-memory-only store instead of sharing the
// first instance's data. Prevent that outright.
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  ipcMain.handle('get-connection-status', () => pairing.getConnectionStatus());

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 780,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#f4ede2', // avoids a white/dark flash while the page loads
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    // Single-purpose tool, not a browser - no File/Edit/View menu bar.
    Menu.setApplicationMenu(null);

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // Send outbound links to the OS's real browser instead of navigating
    // this window away from the app.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      shell.openExternal(url);
    });

    // F11 fullscreen toggle, caught at the Electron level the same way
    // Initiative Tracker does it - BrowserWindows have no built-in F11
    // binding on their own.
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        mainWindow.setFullScreen(!mainWindow.isFullScreen());
        event.preventDefault();
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Start trying to reach Initiative Tracker once there's a window
    // to report status back to. Status changes are pushed to the
    // renderer as they happen, rather than the renderer having to
    // poll for them.
    pairing.startPairing(() => APP_VERSION, (connected) => {
      if (mainWindow) mainWindow.webContents.send('connection-status', { app: 'initiative-tracker', connected });
    });
  }

  app.on('before-quit', () => {
    pairing.stopPairing();
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
