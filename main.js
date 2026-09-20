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

  // Plain BrowserWindow.focus() is not enough on Windows: Windows
  // enforces a "foreground lock" that silently ignores a focus request
  // from a process that isn't already the foreground app - no error,
  // it just does nothing. app.focus({ steal: true }) is Electron's
  // documented way to bypass that; the brief setAlwaysOnTop toggle
  // afterward is an extra nudge some Windows builds still need to
  // actually raise the window rather than just flashing its taskbar
  // icon. Used both for BT's own focus-back-after-IT's-menu-closes
  // path below and could equally replace the plain mainWindow.focus()
  // in the second-instance handler above, though that one hasn't been
  // reported broken so it's left as-is.
  //
  // flashFrame(false) at the end cancels whatever taskbar-flash state
  // is present, regardless of who started it. It matters here because
  // that flash isn't something this app ever asks for (there's no
  // flashFrame(true) anywhere in either app) - it's Windows' own
  // fallback the instant SetForegroundWindow (what win.focus()/
  // app.focus come down to) gets silently denied by the foreground
  // lock above: told "no" on the real focus, Windows flashes the
  // taskbar button instead, as its own consolation notification. The
  // rest of this function is already trying to avoid that denial in
  // the first place; this line is what stops the flash on whatever
  // slice of tries it doesn't quite manage to.
  function forceFocus(win) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    app.focus({ steal: true });
    win.focus();
    win.moveTop();
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
    win.flashFrame(false);
  }

  // ---------------------------------------------------------------------
  // Initiative Tracker remote puppeting - Battle Tracker's side
  // ---------------------------------------------------------------------
  // Each of these just forwards a request over the pairing socket to
  // Initiative Tracker. The four "open-*" ones include this window's
  // current bounds so IT can resize/reposition itself to match (see
  // IT's main.js beginRemotePuppet) - BT itself doesn't move at all,
  // it just sits there until IT reports the menu chain is closed (see
  // the 'remote-menu-closed' handling in the startPairing callback
  // below) and hands focus back.
  ipcMain.handle('remote-open-import', () => {
    if (!mainWindow) return;
    pairing.sendToPeer({ type: 'open-import', bounds: mainWindow.getBounds() });
  });

  ipcMain.handle('remote-open-package', () => {
    if (!mainWindow) return;
    pairing.sendToPeer({ type: 'open-package', bounds: mainWindow.getBounds() });
  });

  ipcMain.handle('remote-open-edit-template', (event, templateId) => {
    if (!mainWindow) return;
    pairing.sendToPeer({ type: 'open-edit-template', bounds: mainWindow.getBounds(), templateId });
  });

  ipcMain.handle('remote-open-edit-package', (event, packageId) => {
    if (!mainWindow) return;
    pairing.sendToPeer({ type: 'open-edit-package', bounds: mainWindow.getBounds(), packageId });
  });

  // Unlike a plain creature's delete (remote-delete-template below,
  // sent straight over the wire - IT has no modal for that one), a
  // package's delete IS a real confirm prompt on IT's side (contents-
  // or-folder-only), so it puppets the window the same as Edit/Import/
  // Package and BT refocuses the instant a choice is made.
  ipcMain.handle('remote-open-delete-package', (event, packageId) => {
    if (!mainWindow) return;
    pairing.sendToPeer({ type: 'open-delete-package', bounds: mainWindow.getBounds(), packageId });
  });

  ipcMain.handle('remote-open-advanced-create', (event, draft) => {
    if (!mainWindow) return;
    pairing.sendToPeer({ type: 'open-advanced-create', bounds: mainWindow.getBounds(), draft });
  });

  // No bounds needed - these don't open anything on IT's side, they
  // just ask it to create/delete a plain creature in the background,
  // mirroring how BT's own plain "Save" has no modal of its own either.
  ipcMain.handle('remote-create-template', (event, data) => {
    pairing.sendToPeer({ type: 'create-template', data });
  });

  ipcMain.handle('remote-delete-template', (event, templateId) => {
    pairing.sendToPeer({ type: 'delete-template', templateId });
  });

  // Package support - expand/collapse and drag-to-reorder/in/out of a
  // package. None of these puppet IT's window: they tell IT what the
  // DM just did on BT's side so IT can reflect the exact same change
  // in its own real templates array (see IT's app.js remoteToggleExpand/
  // remoteReorderTemplate/remoteAddToPackage/remoteRemoveFromPackage),
  // and the next bestiary-sync push is what BT actually renders from -
  // same "instantaneous" pattern as remote-create/delete-template above.
  ipcMain.handle('remote-toggle-expand', (event, packageId) => {
    pairing.sendToPeer({ type: 'toggle-package-expand', packageId });
  });

  ipcMain.handle('remote-reorder-template', (event, { draggedId, targetId, insertBefore }) => {
    pairing.sendToPeer({ type: 'reorder-template', draggedId, targetId, insertBefore });
  });

  ipcMain.handle('remote-add-to-package', (event, { templateId, packageId }) => {
    pairing.sendToPeer({ type: 'add-to-package', templateId, packageId });
  });

  ipcMain.handle('remote-remove-from-package', (event, { templateId, packageId }) => {
    pairing.sendToPeer({ type: 'remove-from-package', templateId, packageId });
  });

  // Creature tray - BT clicking a creature card asks IT to load it into
  // the ledger (IT's real Bestiary card click does exactly this locally
  // already; this is that same action, crossing the wire first). No
  // bounds needed - same reasoning as remote-create-template above,
  // nothing opens on IT's side, just a background change there that
  // the next entity-sync push reflects back here.
  ipcMain.handle('remote-spawn-entity', (event, templateId) => {
    pairing.sendToPeer({ type: 'spawn-entity', templateId });
  });

  // A placed token deleted on BT's map asks IT to remove the matching
  // ledger entry, so the two stay linked - see tray.js.
  ipcMain.handle('remote-remove-entity', (event, entityId) => {
    pairing.sendToPeer({ type: 'remove-entity', entityId });
  });

  // Configure tool's rename button on a paired token asks IT to
  // actually rename the ledger entry, same as clicking its name in the
  // compiler and typing a new one would - see tray.js's renameToken and
  // IT's own remoteRenameEntity. IT's reply comes back as its usual
  // entity-sync push (see 'entity-sync' below), which is what actually
  // updates the token's name/acronym/number here - this call itself
  // doesn't touch tray.js's own state.
  ipcMain.handle('remote-rename-entity', (event, entityId, name) => {
    pairing.sendToPeer({ type: 'rename-entity', entityId, name });
  });

  // Last bestiary-sync payload received from IT, cached here in the
  // main process rather than only ever forwarded once. Fixes a real
  // race: if IT is already open when BT connects, the pairing
  // handshake (and IT's response push, see IT's main.js sending
  // 'request-bestiary-sync' the moment it sees BT connect) can
  // complete within milliseconds of this process starting - often
  // before BT's OWN renderer has finished loading and spawn-tab.js has
  // registered its onBestiarySync listener. That first (and possibly
  // only, since nothing else prompts a second push) 'bestiary-sync'
  // message would otherwise just be sent to nobody and lost, leaving
  // the Spawn tab showing nothing until some unrelated edit on IT's
  // side happens to trigger another push. Caching it here means
  // spawn-tab.js can actively pull the latest state on load (see its
  // getBestiarySync call) instead of only passively waiting for a push
  // it might have missed - same fix shape as get-connection-status
  // already gets for itConnected.
  let lastBestiaryTemplates = [];
  ipcMain.handle('get-bestiary-sync', () => lastBestiaryTemplates);

  // Same race, same fix, for the ledger/entity list the creature tray
  // is built from - see tray.js's getEntitySync call.
  let lastEntities = [];
  ipcMain.handle('get-entity-sync', () => lastEntities);

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
    pairing.startPairing(
      () => APP_VERSION,
      (connected) => {
        if (mainWindow) mainWindow.webContents.send('connection-status', { app: 'initiative-tracker', connected });
      },
      (msg) => {
        // Everything past the hello handshake - Initiative Tracker
        // pushing its Bestiary over (bestiary-sync), or reporting that
        // its own menu chain has fully closed and BT should take focus
        // back (remote-menu-closed). See spawn-tab.js for how the
        // renderer reacts to each of these.
        if (!mainWindow) return;
        switch (msg.type) {
          case 'bestiary-sync':
            lastBestiaryTemplates = Array.isArray(msg.templates) ? msg.templates : [];
            mainWindow.webContents.send('bestiary-sync', lastBestiaryTemplates);
            break;
          case 'entity-sync':
            lastEntities = Array.isArray(msg.entities) ? msg.entities : [];
            mainWindow.webContents.send('entity-sync', lastEntities);
            break;
          case 'remote-menu-closed':
            forceFocus(mainWindow);
            break;
        }
      }
    );
  }

  app.on('before-quit', () => {
    pairing.stopPairing();
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
