// app.js
//
// Skeleton only - no map, no state yet. The menu button opens a menu
// modal with a real Settings tab (mirroring Initiative Tracker's menu
// shell), showing the Connections section. The status dot now
// reflects a real pairing handshake with Initiative Tracker (see
// pairing.js / main.js) - still just presence/absence, no actual data
// flowing over the connection yet.

// ---------------------------------------------------------------------
// GREY / GREEN feature convention
// ---------------------------------------------------------------------
// Every feature added to either app from here on is one or the other:
//
//   GREY  - always available, whether or not the other app is
//           connected. Behavior never changes based on pairing state.
//           The map itself is GREY.
//
//   GREEN - depends on the pairing connection. Typically this means
//           either (a) a simpler standalone tool that gets replaced
//           by a more capable one from the other app once connected
//           (BT's Spawn tab -> IT's real creature data), or (b) a
//           feature that doesn't exist at all until the other app's
//           tools are available to pull from (IT's Spells tab in the
//           creature editor, once it exists, pulling from BT's spell
//           library).
//
// This is decided per feature at the moment it's designed, not
// patched on after the fact - GREEN features should be built with
// their standalone (disconnected) behavior as a first-class case from
// day one, not an afterthought bolted on once pairing already works.
//
// FEATURE_KIND is the registry: every top-level feature (right now,
// just the sidebar tabs) is tagged here. Nothing reads this yet to
// actually gate anything - that logic (swap-in/enable-on-connect)
// comes later, once there's a real GREEN feature to wire it up for.
// It's recorded now, alongside data-feature on the tab buttons
// themselves, so that hookup has a single obvious place to attach to
// instead of being reverse-engineered from the DOM later.
const FEATURE_KIND = {
  draw: 'grey',
  spawn: 'green',
  spells: 'grey',
  play: 'grey',
};

const menuBtn = document.getElementById('menuBtn');
const menuModalEl = document.getElementById('menuModal');
const menuCloseBtn = document.getElementById('menuCloseBtn');
const menuContentEl = document.getElementById('menuContent');

// ---------------------------------------------------------------------
// Sidebar collapse
// ---------------------------------------------------------------------

const sideColWrapper = document.getElementById('sideColWrapper');
const sideCollapseTab = document.getElementById('sideCollapseTab');

function toggleSidebar() {
  const collapsed = sideColWrapper.classList.toggle('collapsed');
  sideCollapseTab.title = collapsed ? 'Expand' : 'Collapse';
}

sideCollapseTab.addEventListener('click', toggleSidebar);

// Tab collapses/expands the sidebar - freed up for this now that any
// tool can be put down with its own 1-9 hotkey instead (see
// draw-tab.js), so Tab no longer needs to double as "put the tool
// down." Not gated to any particular side tab, unlike the 1-9 tool
// hotkeys - the sidebar itself is a shared, always-present piece of
// the app, not something owned by whichever tab happens to be open.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // let Tab behave normally while actually typing somewhere
  // preventDefault has to run on every firing, repeats included - it
  // was previously skipped whenever e.repeat was true (the early
  // return happened before this line), which let the browser's native
  // focus-cycling take over the moment Tab was held down instead of
  // just tapped once. The repeat guard below still limits the actual
  // toggle to once per press, it just can't gate preventDefault too.
  e.preventDefault();
  if (e.repeat) return; // holding the key fires repeated keydowns at the OS repeat rate - without this, holding Tab rapid-fires the toggle instead of firing once per actual press
  toggleSidebar();
});

// ---------------------------------------------------------------------
// Sidebar feature tabs (Draw / Spawn / Spells / Play)
// ---------------------------------------------------------------------
// Switching just changes which tab is marked active right now - every
// tab's content is blank until the features themselves get built.

const sideTabBtns = document.querySelectorAll('.side-tab-btn');
const sideScrollEl = document.getElementById('sideScroll');
const headerLeftEl = document.getElementById('headerLeft');
let activeSideTab = 'draw';
window.isSideTabActive = (tab) => activeSideTab === tab;

// Each tab that has real content registers a render function here
// (see draw-tab.js) instead of this file needing to know about every
// tab's internals. A tab with nothing registered just gets a blank
// panel, same as before any of them had content. SideTabHeaderRenderers
// is the same idea for the header's left zone (currently only Draw's
// tool icons/Mode buttons use it) - a tab with nothing registered
// there just gets a blank header-left, so switching away from Draw
// clears its tool UI automatically.
window.SideTabRenderers = window.SideTabRenderers || {};
window.SideTabHeaderRenderers = window.SideTabHeaderRenderers || {};

function setActiveSideTab(tab) {
  // Switching modes puts down whatever Draw tool is currently
  // equipped (and, for Configure specifically, drops its target/
  // highlight along with it) - guarded on an actual change so
  // clicking the already-active tab's own button doesn't put down a
  // tool the DM never left. window.BattleDraw might not exist yet
  // this early (see the "first real paint" call below, made before
  // draw-tab.js's own IIFE has finished setting it up) - nothing to
  // unequip that first time regardless.
  if (tab !== activeSideTab && window.BattleDraw && window.BattleDraw.unequipActiveTool) {
    window.BattleDraw.unequipActiveTool();
  }
  activeSideTab = tab;
  for (const btn of sideTabBtns) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  const renderer = window.SideTabRenderers[tab];
  if (renderer) {
    renderer();
  } else {
    sideScrollEl.innerHTML = '';
  }
  const headerRenderer = window.SideTabHeaderRenderers[tab];
  if (headerRenderer) {
    headerRenderer();
  } else if (headerLeftEl) {
    headerLeftEl.innerHTML = '';
  }
}

for (const btn of sideTabBtns) {
  btn.addEventListener('click', () => setActiveSideTab(btn.dataset.tab));
}

// Initiative Tracker connection status - pushed from the main process
// as it changes, not polled. Kept as simple module state so the dot
// can be repainted immediately if Settings happens to be open when a
// connection comes or goes, without a full renderMenuContent() redo.
let itConnected = false;

if (window.electronAPI && window.electronAPI.getConnectionStatus) {
  window.electronAPI.getConnectionStatus().then((status) => {
    itConnected = status.connected;
    updateConnectionDot();
  });
}

if (window.electronAPI && window.electronAPI.onConnectionStatus) {
  window.electronAPI.onConnectionStatus((payload) => {
    if (payload.app !== 'initiative-tracker') return;
    itConnected = payload.connected;
    updateConnectionDot();
  });
}

function updateConnectionDot() {
  const dot = document.getElementById('itConnectionDot');
  if (!dot) return; // Settings tab isn't open right now - nothing to repaint
  dot.classList.toggle('connected', itConnected);
  dot.title = itConnected ? 'Connected' : 'Not connected';
}

function renderMenuContent() {
  menuContentEl.innerHTML = `
    <h3>Settings</h3>

    <div class="settings-section-header">
      <h4>Connections</h4>
    </div>
    <div class="settings-row connection-row">
      <div class="settings-row-label">Initiative Tracker</div>
      <span id="itConnectionDot" class="connection-status-dot${itConnected ? ' connected' : ''}" title="${itConnected ? 'Connected' : 'Not connected'}"></span>
    </div>
  `;
}

menuBtn.addEventListener('click', () => {
  renderMenuContent();
  menuModalEl.classList.remove('hidden');
});

menuCloseBtn.addEventListener('click', () => {
  menuModalEl.classList.add('hidden');
});

menuModalEl.addEventListener('click', (e) => {
  if (e.target === menuModalEl) menuModalEl.classList.add('hidden');
});
