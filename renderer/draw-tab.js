// draw-tab.js
//
// The Draw tab's sidebar UI (Walls / Textures / Structures / Logic)
// and the placement/deletion logic that turns a click on the map into
// a stored wall/texture/structure (or removes one). The Place/Delete
// tool selector itself lives in the header (see renderHeaderLeft),
// not the sidebar - that's what "Tools" used to be here, but the tool
// switcher is reached for constantly while drawing and doesn't
// belong two clicks and a scroll away from the canvas it controls.
// The Logic section took its place instead. Fully GREY (see the
// GREY/GREEN convention in app.js) - nothing here reads or changes
// based on the Initiative Tracker connection, and nothing about it
// ever should.
//
// Placed content lives in three maps, keyed by grid coordinate:
//   walls      "h:col,row" / "v:col,row" -> wall type id
//   textures   "col,row"                 -> texture type id
//   structures "col,row"                 -> structure type id
// A cell can hold one texture and one structure at once (different
// layers), but never two of the same layer stacked - the same reason
// walls key off an edge type + coordinate rather than a plain cell.

(function () {
  const WALL_COLOR = '#14100d';

  // Walls represent themselves - a line, styled the way it'll
  // actually be drawn - rather than a labeled swatch, since the line
  // style *is* the information. solid/dashed/dotted are a straight
  // stroke with a dash pattern; zigzag/wavy need an actual patterned
  // path (see buildEdgePath) rather than just a dash array.
  const WALL_TYPES = [
    { id: 'solid', pattern: 'straight', dash: [] },
    { id: 'dashed', pattern: 'straight', dash: [8, 5] },
    { id: 'dotted', pattern: 'straight', dash: [1.5, 4.5] },
    { id: 'zigzag', pattern: 'zigzag' },
    { id: 'wavy', pattern: 'wavy' },
  ];

  // Textures fill the whole cell rather than sitting on an edge.
  // Default color is black - "will need to be able to be recolored,
  // more on that later" is a UI feature that doesn't exist yet, but
  // the color already lives on the type object so adding it later is
  // a data change, not an architecture change.
  const TEXTURE_TYPES = [
    { id: 'solid', pattern: 'solid', color: '#14100d' },
    { id: 'diagonal', pattern: 'diagonal', color: '#14100d' },
    { id: 'dotted', pattern: 'dotted', color: '#14100d' },
    { id: 'wavy', pattern: 'wavy', color: '#14100d' },
    { id: 'cracked', pattern: 'cracked', color: '#14100d' },
  ];

  // Four cracks, each starting at a cell edge and zigzagging lightly
  // inward - none reach the center, since real cracks in a surface
  // start at an edge/weak point and don't necessarily meet in the
  // middle. Each has a jagged main line plus 1-2 shorter branches
  // forking off it partway along, which is what actually reads as a
  // "crack" rather than just a squiggle. Normalized to a 0-1 unit
  // square, and fixed rather than randomly generated per cell/render
  // for the same reason as before - a stable pattern reads as
  // intentional, a fresh random one every frame would just look like
  // noise. Reused for both the map rendering and the sidebar preview.
  const CRACK_DEFS = [
    {
      main: [[0.3, 0], [0.34, 0.09], [0.27, 0.16], [0.32, 0.25]],
      branches: [
        [[0.34, 0.09], [0.43, 0.14], [0.47, 0.22]],
        [[0.27, 0.16], [0.2, 0.2], [0.22, 0.28]],
      ],
    },
    {
      main: [[1, 0.35], [0.9, 0.38], [0.94, 0.46], [0.85, 0.5]],
      branches: [
        [[0.9, 0.38], [0.82, 0.3], [0.76, 0.32]],
      ],
    },
    {
      main: [[0.65, 1], [0.6, 0.9], [0.66, 0.82], [0.58, 0.74]],
      branches: [
        [[0.6, 0.9], [0.5, 0.88], [0.44, 0.92]],
      ],
    },
    {
      main: [[0, 0.7], [0.1, 0.66], [0.06, 0.58], [0.14, 0.52]],
      branches: [
        [[0.1, 0.66], [0.18, 0.72], [0.24, 0.68]],
      ],
    },
  ];

  // A compact, self-contained crack icon for previews (sidebar swatch
  // and the header's item picker) - deliberately not built from
  // CRACK_DEFS above. Those four cracks are anchored to a square
  // cell's edges and stay clear of the center on purpose (see
  // CRACK_DEFS' own comment); shrunk into a small rectangular button
  // they read as disconnected scratches in the corners rather than a
  // crack. This is one continuous jagged line with a couple of short
  // branches, drawn to actually fill a 50x30 box on its own terms.
  const CRACKED_ICON_SVG = '<svg viewBox="0 0 50 30" width="50" height="30">'
    + '<path d="M6,6 L17,12 L11,17 L23,22 L16,27" stroke="#14100d" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M17,12 L28,9" stroke="#14100d" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
    + '<path d="M11,17 L3,21" stroke="#14100d" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
    + '<path d="M23,22 L33,25" stroke="#14100d" stroke-width="1.3" fill="none" stroke-linecap="round"/>'
    + '</svg>';

  // Structures are the third placed-content layer, drawn over
  // textures (see renderOverlay) with their own opaque background so
  // whatever texture is underneath doesn't show through - unlike
  // textures, which default to transparent. Each type's actual
  // drawing is bespoke (see drawStairsIcon/drawChestIcon) rather than
  // parametric like walls/textures, since there isn't a shared
  // pattern vocabulary between "a staircase" and "a chest" the way
  // there is between "dashed" and "dotted". Rotatable via the R
  // hotkey - see placeRotation below.
  //
  // Door is listed here (it's picked from the Structures section, and
  // shares placeRotation/the R hotkey/the reset-on-switch
  // behavior) but it's NOT stored in the structures/structureRotations
  // maps below - a door sits on an edge exactly like a wall does, not
  // centered in a cell, so it gets its own edge-keyed `doors` map
  // instead (see below) and is special-cased wherever placement,
  // deletion, and rendering would otherwise assume a cell.
  const STRUCTURE_TYPES = [
    { id: 'stairs' },
    { id: 'chest' },
    { id: 'item' },
    { id: 'lever' },
    { id: 'door' },
  ];

  // Logic pieces - the one category that can sit on EITHER a tile or a
  // line (an edge), decided per-instance by where it was actually
  // clicked (see handleMapClick's 'logic' branch), same edge-takes-
  // priority-when-close-enough convention as everything else. Now
  // shown by Configure too (position only - no rotation, no color
  // system, and no actual logic behavior behind them yet; the icons
  // describe what they'll eventually do). Always rendered on top of
  // every other placed-content layer - see renderOverlay's `logic`
  // loop, drawn last of the four.
  const LOGIC_TYPES = [
    { id: 'switch' },
    { id: 'break' },
    { id: 'hide' },
    { id: 'recolor' },
    { id: 'move' },
  ];

  const walls = new Map();
  const textures = new Map();
  const structures = new Map();
  // Per-instance rotation (0-3, quarter-turns), keyed the same way as
  // structures/textures themselves. Something with no entry here
  // renders at its default (0) orientation, same convention as
  // wallColors/textureColors defaulting to "no override yet".
  const structureRotations = new Map();
  // Same idea, for textures - patterns like diagonal/dotted/wavy read
  // differently rotated, unlike solid/cracked which are rotation-
  // invariant but harmlessly carry a rotation value anyway (simpler
  // than special-casing which patterns "care").
  const textureRotations = new Map();
  // Doors - edge-keyed ("h:col,row" / "v:col,row", same as walls,
  // built with wallKey()) rather than cell-keyed, since a door sits on
  // the line between two cells the same way a wall does. Value is the
  // door's own rotation (0-3) directly, rather than a separate
  // presence+rotation pair - there's only one door "type", so
  // presence and rotation collapse into one map. A wall and a door
  // can never occupy the same edge at once (see the placement code) -
  // placing a door removes whatever wall was there first.
  const doors = new Map();
  // Doors's open/closed state - edge-keyed, same as `doors` itself.
  // Missing entry (or false) means closed, the default. Cleared
  // alongside every other per-instance door state on delete/replace.
  const doorOpenStates = new Map();
  // Lever's off/on state - cell-keyed, same as `structures` itself.
  // Missing entry (or false) means off, the default. Only ever
  // populated for lever-type structures; harmless (just unused) for
  // any other type's key. Cleared alongside every other per-instance
  // structure state on delete/replace.
  const leverOnStates = new Map();
  // Logic pieces - keyed by EITHER an edge key (wallKey(), when placed
  // on a line) or a cell key (cellKey(), when placed on a tile). Both
  // key shapes can coexist in this one Map since they're textually
  // distinguishable (an edge key always has a ':' - see parseWallKey);
  // renderOverlay/handleMapClick check for that rather than needing two
  // separate maps the way walls/textures do.
  const logic = new Map(); // key -> typeId ('switch' | 'break' | 'hide' | 'recolor' | 'move')
  // Switch's own trigger configuration - keyed the same way as `logic`
  // itself (edge or cell key, whichever this particular switch sits
  // on). Missing entry means the defaults noted below apply; only
  // ever populated for switch-type logic pieces, harmless (just
  // unused) for any other type's key - same convention as
  // leverOnStates being harmless on a non-lever structure. Cosmetic
  // only for now: nothing reads these to actually fire anything yet
  // (see "What's explicitly NOT built yet" - Play mode doesn't exist),
  // this only drives what the Configure menu displays.
  const switchTriggerModes = new Map(); // key -> 'pulse' | 'interact' | 'roundStart' | 'turnStart'; missing = 'pulse' (the default)
  const switchEveryTurn = new Map(); // key -> bool; missing/false = off (the default). Only meaningful when switchTriggerModes.get(key) === 'turnStart'.
  // Break/Hide/Recolor/Move's own "Trigger on:" - unlike Switch, none
  // of these four have an Every Turn branch (Turn Start always shows a
  // Pulse source row for them, no toggle first), so they share ONE
  // trigger-mode map rather than each getting their own - safe because
  // a given key only ever holds ONE logic piece at a time (the shared
  // `logic` Map itself enforces that), so there's no cross-type
  // collision risk in sharing storage keyed the same way.
  const logicTriggerModes = new Map(); // key -> 'pulse' | 'interact' | 'roundStart' | 'turnStart'; missing = 'pulse' (the default)

  // --- Break ---
  const breakWarning = new Map(); // key -> bool; missing/true = on (the default, per spec's "(y)/n")

  // --- Hide ---
  const hideSequence = new Map(); // key -> bool; missing/false = off (the default)
  const hideOpacityMode = new Map(); // key -> 'to' | 'by'; missing = 'to' (the default)
  const hideOpacityToValue = new Map(); // key -> 0-100; missing = 0 (the default)
  const hideOpacityByDirection = new Map(); // key -> '+' | '-'; missing = '-' (the default, per spec's "[+/(-)]")
  const hideOpacityByValue = new Map(); // key -> 0-100; missing = 50 (the default)
  // key -> bool; missing = contextual default (see hideReturnOnRetriggerDefault) -
  // "to" mode defaults on, "by" mode defaults off, matching the spec's
  // own per-branch parenthesization ("(y)/n" vs "y/(n)").
  const hideReturnOnRetrigger = new Map();
  const hideSequenceSteps = new Map(); // key -> array of { opacityMode, opacityToValue, opacityByDirection, opacityByValue } - only shown/used while hideSequence is on
  const hideReturnOnLoop = new Map(); // key -> bool; missing/true = on (the default)

  // --- Recolor ---
  const recolorSequence = new Map(); // key -> bool; missing/false = off (the default)
  const recolorColors = new Map(); // key -> { primary: hex }; missing/no primary = DEFAULT_PRIMARY_COLOR (the default) - the "Set Color" swatch, reusing the same {primary,secondary}-shaped override/picker UI as wall/texture/structure via colorMapFor's 'logic' case (secondary is simply never used - Recolor's spec has only the one color)
  const recolorReturnOnRetrigger = new Map(); // key -> bool; missing/true = on (the default)
  const recolorSequenceSteps = new Map(); // key -> array of { color } - only shown/used while recolorSequence is on
  const recolorReturnOnLoop = new Map(); // key -> bool; missing/true = on (the default)

  // --- Move ---
  const moveSequence = new Map(); // key -> bool; missing/false = off (the default)
  const moveAction = new Map(); // key -> 'move' | 'rotate'; missing = 'move' (the default)
  const moveMode = new Map(); // key -> 'to' | 'by'; missing = 'to' (the default) - shared by both Move and Rotate, matching the spec's single "[(to), by]" selector under either action
  const moveNewPosition = new Map(); // key -> { x, y, z }; missing = { x:0, y:0, z:0 }
  const moveAdjust = new Map(); // key -> { x, y, z }; missing = { x:0, y:0, z:0 }
  const moveNewRotation = new Map(); // key -> 0-3 (quarter turns); missing = 0 - driven by the same 90°-increment rotate button used everywhere else, per the person's explicit direction (no numeric input)
  const moveRotateAdjustDirection = new Map(); // key -> '+' | '-'; missing = '+' (the default, per spec's "(+)/-")
  const moveRotateAdjustStep = new Map(); // key -> 0-3 (quarter turns); missing = 0
  // key -> bool; missing = contextual default (see moveReturnOnRetriggerDefault) -
  // "to" mode defaults on, "by" mode defaults off, same rule as Hide's.
  const moveReturnOnRetrigger = new Map();
  const moveSequenceSteps = new Map(); // key -> array of { action, mode, newPosition, adjust, newRotation, rotateAdjustDirection, rotateAdjustStep } - only shown/used while moveSequence is on
  const moveReturnOnLoop = new Map(); // key -> bool; missing/true = on (the default)

  // Every per-instance Logic-piece setting Map declared above, in one
  // list - used by moveItem's generic carry-across-a-move logic and by
  // the delete call sites below, so a new setting Map only needs to be
  // added here once rather than at every one of those sites individually.
  // switchTriggerModes/switchEveryTurn are included too even though
  // Switch is otherwise handled with its own explicit code elsewhere -
  // this list is specifically the "clear/carry all Logic settings,
  // whichever type actually owns them" mechanism.
  const LOGIC_INSTANCE_MAPS = [
    switchTriggerModes, switchEveryTurn,
    logicTriggerModes,
    breakWarning,
    hideSequence, hideOpacityMode, hideOpacityToValue, hideOpacityByDirection, hideOpacityByValue, hideReturnOnRetrigger, hideSequenceSteps, hideReturnOnLoop,
    recolorSequence, recolorColors, recolorReturnOnRetrigger, recolorSequenceSteps, recolorReturnOnLoop,
    moveSequence, moveAction, moveMode, moveNewPosition, moveAdjust, moveNewRotation, moveRotateAdjustDirection, moveRotateAdjustStep, moveReturnOnRetrigger, moveSequenceSteps, moveReturnOnLoop,
  ];

  // Every Map the generic .configure-toggle-switch click handler (in
  // both wireConfigurePanel and wireHeaderConfigureDetails) can write
  // to, keyed by the data-toggle-map name used in its markup. A map not
  // listed here (leverOnStates/doorOpenStates/switchEveryTurn default
  // to "off", so they've never needed a data-toggle-default) still
  // defaults to false when read - see that handler's own toggle logic.
  const LOGIC_TOGGLE_MAPS_BY_NAME = {
    leverOnStates, doorOpenStates, switchEveryTurn,
    breakWarning,
    hideSequence, hideReturnOnRetrigger, hideReturnOnLoop,
    recolorSequence, recolorReturnOnRetrigger, recolorReturnOnLoop,
    moveSequence, moveReturnOnRetrigger, moveReturnOnLoop,
  };
  // Per-instance paint overrides, keyed the same way as the maps
  // above - a wall/texture keeps its type's default color until
  // something's actually been painted onto that specific instance.
  // Walls only ever get a primary (their stroke) - they have no fill
  // to speak of yet. Textures get both: primary is the pattern's own
  // ink, secondary is the cell's background behind it ("the rest of
  // the floor").
  const wallColors = new Map(); // key -> { primary }
  const textureColors = new Map(); // key -> { primary, secondary }
  // Structures get both too (their ink and their backing) - keyed the
  // same way structures/structureRotations are (cell key for most
  // types, edge key via wallKey() for door specifically, matching
  // whichever map actually stores that structure - see
  // structureColorKey).
  const structureColors = new Map(); // key -> { primary, secondary }

  // The Paint tool's currently loaded colors - what the next stroke
  // will apply, not any particular instance's color. Defaults match
  // the existing default ink/background so painting starts out as a
  // no-op until the DM actually picks something.
  const DEFAULT_PRIMARY_COLOR = '#14100d';
  const DEFAULT_SECONDARY_COLOR = '#f4ede2'; // exactly --bg - "the color of the battlemap itself"
  // How far apart (in saturation points) an auto-derived color sits
  // from the one it was derived from - see setPaintColor.
  const SHADE_SATURATION_OFFSET = 25;

  let paintPrimaryColor = DEFAULT_PRIMARY_COLOR;
  let paintSecondaryColor = DEFAULT_SECONDARY_COLOR;
  // The hex values above are what everything else (canvas fills, CSS
  // backgrounds, storage) actually wants, but they're an 8-bit-per-
  // channel snapshot - re-deriving hue/saturation from hex on every
  // render is what caused both picker bugs: hitting 0 saturation or 0
  // brightness makes a color perfectly achromatic, where hue becomes
  // mathematically undefined and any recomputation collapses it to 0
  // (reads as "locked to the leftmost hue"); and 8-bit rounding means
  // a hex value doesn't always reconstruct the *exact* h/s/v that
  // produced it, so re-deriving after every slider move nudges things
  // by fractions of a percent (reads as "the square shifts slightly").
  // These track the true, continuous values directly - hex is derived
  // FROM them, never the other way around, for any edit that
  // originates inside this app (the SV square, the H/S/B sliders).
  // Only genuinely external sources (a recent/favorite chip, the
  // system eyedropper) have nothing but a hex value to start from,
  // and have to derive HSV from it once at that entry point - see
  // setPaintColorHex vs setPaintColorHSV below.
  let paintPrimaryHSV = hexToHsv(DEFAULT_PRIMARY_COLOR);
  let paintSecondaryHSV = hexToHsv(DEFAULT_SECONDARY_COLOR);
  // Whether each color has actually been chosen by the DM, as opposed
  // to just sitting at its hardcoded default or having been auto-
  // derived as a shade of the other one. Drives the reset buttons'
  // disabled state, and whether a given color still "follows" the
  // other one when it changes - see setPaintColor/resetPaintColor.
  let primaryManuallySet = false;
  let secondaryManuallySet = false;

  const MAX_RECENT_COLORS = 15; // 5 columns x 3 rows
  const recentPaintColors = []; // hex strings, most recent first - populated below by loadPersistedPaintColors()
  const favoritePaintColors = []; // hex strings, right-click a recent swatch to add

  // Persisted across app restarts via localStorage - Electron's
  // renderer process is just Chromium, so this writes to disk the
  // same way it would for any website, tied to this app's own
  // profile. Wrapped in try/catch throughout since storage can
  // theoretically fail (corrupted profile, disk full, etc.) and
  // losing a color list shouldn't be able to crash the app over it -
  // especially not favorites, which is the one the DM is most likely
  // to actually mind losing.
  const RECENT_COLORS_STORAGE_KEY = 'bt-paint-recent-colors';
  const FAVORITE_COLORS_STORAGE_KEY = 'bt-paint-favorite-colors';

  function loadPersistedPaintColors() {
    try {
      const raw = localStorage.getItem(RECENT_COLORS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) recentPaintColors.push(...parsed.slice(0, MAX_RECENT_COLORS));
    } catch (e) { /* corrupt or missing - just start empty */ }
    try {
      const raw = localStorage.getItem(FAVORITE_COLORS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) favoritePaintColors.push(...parsed);
    } catch (e) { /* corrupt or missing - just start empty */ }
  }
  function persistRecentPaintColors() {
    try { localStorage.setItem(RECENT_COLORS_STORAGE_KEY, JSON.stringify(recentPaintColors)); } catch (e) { /* non-fatal */ }
  }
  function persistFavoritePaintColors() {
    try { localStorage.setItem(FAVORITE_COLORS_STORAGE_KEY, JSON.stringify(favoritePaintColors)); } catch (e) { /* non-fatal */ }
  }

  let colorDropdownOpen = null; // null | 'primary' | 'secondary' - the header dropdown specifically
  let headerRecentDropdownOpen = false;
  let headerFavoriteDropdownOpen = false;
  // Which color the sidebar's Paint Mode panel is currently editing -
  // primary by default, switched by clicking either preview square.
  let paintColorTarget = 'primary';
  // Which favorite (by hex) is currently showing its "remove this?"
  // confirmation popup, if any - right-clicking a favorite a second
  // time (or clicking Yes) commits the removal; clicking Cancel,
  // right-clicking elsewhere, or any of the existing click-away
  // triggers just dismiss it. Only one confirmation shows at a time.
  let favoriteRemoveConfirmHex = null;
  // Same leak-avoidance pattern as colorDragTarget below: one-time
  // window listeners driven by this flag, rather than a fresh pair
  // attached on every render of the SV square.
  let svDragActive = false;
  // Which color (if any) is actively being dragged on its wheel right
  // now - drives the ONE-TIME window-level mousemove/mouseup listeners
  // registered near the bottom of this file, rather than each having
  // its own per-render window listener that would never get removed
  // when the dropdown closes and re-renders (a real leak: every open/
  // close cycle would pile on another stale pair of listeners, each
  // still holding a closure over that render's now-detached elements).
  let colorDragTarget = null;

  let activeTool = null; // starts off - Place has to be turned on (directly, or automatically by selecting something to place)
  let selected = null; // { category: 'wall' | 'texture' | 'structure', id } - persists across activating/deactivating a tool and across Tab; see the tool button and Tab handlers below

  // Remembers the last id chosen within each category, independent of
  // `selected` itself - so switching category in the header picker
  // (see renderSelectionGroup) can restore what was last chosen there
  // instead of always resetting to that category's first item. Never
  // cleared by deselecting; only ever updated by an actual pick.
  const lastSelectedByCategory = {};
  function setSelected(next) {
    // Rotation is a dial for whatever's currently selected, not a
    // persistent global - switching to a different item (even within
    // the same category) starts back at 0 rather than carrying over
    // whatever was last dialed in for the previous selection. See
    // placeRotation.
    if (next && (!selected || selected.category !== next.category || selected.id !== next.id)) {
      placeRotation = 0;
    }
    selected = next;
    if (selected) lastSelectedByCategory[selected.category] = selected.id;
  }

  // Each tool keeps its own mode independently, and neither resets on
  // switching tools, changing what's selected, or Tab - only ever set
  // by the DM explicitly choosing a different one. The one exception
  // isn't a reset so much as a translation: Place's second mode
  // (whichever of the two isn't Click) has to mean something
  // different depending on what's selected - Line only makes sense
  // for walls - so changing selection while parked in that slot
  // updates which concrete mode it maps to without leaving the slot
  // itself. See the swatch click handler below.
  //   placeMode:  'click' | 'line' (walls selected) | 'drag' (anything else selected)
  //   deleteMode: 'click' | 'select'
  let placeMode = 'click';
  let deleteMode = 'click'; // 'drag' replaced by 'click' - see syncDragBehavior
  let paintMode = 'drag'; // matches Paint's original always-continuous behavior by default
  // Arrange (click-and-drag an item to a new location) or Interact
  // (left-click a structure to activate it) - see syncDragBehavior for
  // how this maps to map.js's own dragBehavior, and
  // handleArrangeGesture/handleSelectToolClick for what each mode
  // actually does.
  let selectMode = 'arrange';
  // The item currently being dragged in Arrange mode, or null -
  // { category, key, typeId, fromEdgeKey } where fromEdgeKey records
  // whether the ORIGINAL key was edge- or cell-shaped (an item can
  // only ever be picked up from one shape, but see
  // handleArrangeGesture for how the drop target is resolved
  // differently per category). Cleared on commit or if the tool/mode
  // changes out from under a drag in progress.
  let arrangeDragItem = null;
  // Live cursor position while dragging, in the same {col,row,edge}
  // shape computeCellInfo returns - used purely for the drag's own
  // ghost-preview rendering, not for anything committed.
  let arrangeDragCurrentInfo = null;
  // Edit (the existing behavior - click a tile/edge to inspect/adjust
  // what's there) or Wire (not built yet - will eventually connect
  // Logic pieces to each other/to structures; for now just a
  // placeholder panel, see renderConfigurePanel). Doesn't affect
  // handleMapClick's own configure branch - configureTarget tracking
  // stays the same in both, only the SIDEBAR panel differs.
  let configureMode = 'edit';
  // What the Configure tool is currently showing in the sidebar -
  // { col, row, edge } - edge is whatever info.edge resolved to for
  // that same click (null if it wasn't close enough to any edge), so
  // a single click can surface both a tile's contents (texture,
  // structure) and its nearest edge's contents (wall, door) at once -
  // no separate tile/grid mode to choose between. null if nothing's
  // been clicked yet. Deliberately just the location, not a snapshot
  // of its contents - renderConfigurePanel re-reads the live walls/
  // textures/structures/doors maps every time it renders, so the list
  // always reflects current state even if something at that spot
  // changes from elsewhere.
  let configureTarget = null;

  // Wires - DM annotations connecting one item to another. Only ever
  // meaningful in Play mode, and only when `from` is a Logic piece
  // (that's what actually makes something happen there) - a wire
  // between two non-Logic items is a harmless note that does nothing,
  // which is allowed on purpose (see the person's own framing: "you
  // can still draw wires... as a DM note regardless of if they would
  // have any functionality"). Each endpoint needs both a key AND a
  // category since one location can hold several items at once (a
  // cell's texture and structure share a key, for instance) - `key`
  // alone can't tell them apart.
  //   wires: [{ fromKey, fromCategory, toKey, toCategory, color }, ...]
  // One item can be the `from` of many wires (fan-out) - there's no
  // uniqueness constraint on fromKey/fromCategory, only on the full
  // (from, to) pair (see the trigger-dropdown "dim exact duplicates"
  // rule in wireConfigurePanel). `color` defaults to DEFAULT_PRIMARY_COLOR
  // (#14100d) at creation, same default every other paintable thing
  // in this app starts from - see wireDrawColor below for where a
  // freshly-created wire's starting color actually comes from.
  const wires = [];
  // The color a NEW wire gets when it's created, editable via the
  // header's own wire-color row (see renderHeaderWirePickers) - same
  // idea as Paint's primary color, just scoped to wires. Also doubles
  // as the color of the in-progress line following the cursor, so
  // changing it gives immediate feedback on the wire actually being
  // built. Resets to the default alongside everything else in
  // cancelPendingWire - a wire that gets abandoned shouldn't leave
  // this pointing at whatever color it happened to be left on.
  let wireDrawColor = DEFAULT_PRIMARY_COLOR;
  // Which wire's color row currently has its SV-square picker open -
  // 'pending' (the header's own row) or a wires[] index as a string,
  // or null. Mirrors configureColorPickerOpen's role for Edit mode's
  // own item colors.
  let wireColorPickerOpen = null;
  // True while actively dragging the wire picker's SV square, and
  // which container (sidebar or header) it was opened in - a drag can
  // continue after the mouse leaves the square itself, so the
  // window-level mousemove/mouseup listeners need to remember which
  // DOM tree's #wireSvSquare to keep updating.
  let wireColorDragActive = false;
  let wireColorDragContainer = null;
  // Which wire's color row currently has its hex text editable in
  // place of the usual hex button - 'pending' (the header's own row)
  // or a wires[] index as a string, or null. Only one open at a time,
  // shared between the sidebar's per-wire rows and the header's row.
  let wireHexEditing = null;
  // The wire currently being built, or null - { key, category }
  // identifying its source item. Sidebar (and eventually map/header)
  // Wire-mode UI reads this to know whose "Connected to:" row is live
  // right now. Deliberately NOT part of snapshotState/restoreState -
  // this is transient in-progress UI state, not placed content, same
  // treatment as configureHexEditing below.
  // Cleared whenever the tool changes out from under it (equipTool,
  // switching Configure back to Edit) - see those call sites.
  let pendingWireSource = null;
  // The second location clicked while a wire is pending - { edge } or
  // { col, row }, same shape configureTarget itself takes, or null
  // until something's been clicked. Deliberately separate from
  // configureTarget: per spec, the sidebar stays focused on the
  // SOURCE's own location for the whole wire-creation gesture, so a
  // destination click can't be allowed to move configureTarget the
  // way it normally would. Reset alongside pendingWireSource whenever
  // a wire completes or gets abandoned.
  let pendingWireDestTarget = null;
  // A generic, reusable right-click context menu anchored to the map -
  // Wire mode's item picker is just its first consumer, not something
  // baked into it; other tools/features can call showMapContextMenu
  // later without touching this plumbing. { items } once shown, where
  // items is [{ label, disabled, onClick }] - null when closed. Fixed
  // at the screen position it was opened at (standard context-menu
  // behavior) rather than tracking pan/zoom like a map-anchored
  // highlight would - it's expected to get dismissed (an item picked,
  // or a click elsewhere) well before anything would pan underneath
  // it.
  let mapContextMenu = null;
  const mapContextMenuEl = document.getElementById('mapContextMenu');

  // Which item's color chip currently has its mini-picker open -
  // { category, key, which } - or null. Mirrors colorDropdownOpen's
  // role for the header, but scoped to whichever item the Configure
  // panel is currently showing rather than the global paint color.
  // { category, key, which, source } or null - source is 'header' or
  // 'sidebar', recording which surface actually opened the picker.
  // Both surfaces show the exact same item/which target (the whole
  // point of Edit-mode redundancy), but only ONE picker is ever open
  // at a time app-wide, and its markup only lives inside whichever
  // surface opened it - source is how each render function knows
  // whether ITS copy of the (shared, fixed-id) #configureSvSquare
  // markup should be the one that actually gets emitted, so the two
  // never both try to render into the DOM at once and collide on id.
  let configureColorPickerOpen = null;
  // Same idea for the hex text turning into an editable input -
  // { category, key, which, source } or null. Mutually exclusive with
  // the picker above (opening one closes the other).
  let configureHexEditing = null;
  // True while actively dragging the Configure picker's SV square -
  // mirrors colorDragTarget's role for the header's picker.
  let configureColorDragActive = false;
  // Whichever container (sideScrollEl or headerLeftEl) actually holds
  // the currently-open #configureSvSquare - mirrors wireColorDragContainer's
  // role, since a drag can continue after the mouse leaves the square.
  let configureColorDragContainer = null;
  // Which wire's destination dropdown is currently open, if any -
  // 'pending' for the in-progress wire being built, a number (a wires[]
  // index) for reopening an already-committed wire to repoint it, or
  // null for none open. Only one can ever be open at a time.
  let configureWireDropdownOpen = null;

  // Edit mode's own header cluster - the header's compact mirror of
  // whatever the sidebar is showing for the current configureTarget.
  // configureSelectedItem is { key, category } for whichever item the
  // header's own dropdown currently points at, or null when nothing's
  // resolved yet (no target, nothing there, or more than one item and
  // none explicitly chosen). It's read back through
  // getConfigureSelectedItem() below rather than used directly, since
  // that's also what auto-focuses the sole item when only one exists.
  let configureSelectedItem = null;
  let configureItemDropdownOpen = false;
  // The header's own gear/Settings dropdown for the selected item -
  // covers the item's toggle-style settings row (lever/door) or the
  // Switch trigger settings below.
  let configureSettingsDropdownOpen = false;
  // Switch's own "Trigger on:" picker - { key, source: 'sidebar' |
  // 'header' } for whichever surface's copy is currently open, or null
  // for neither. Same .source-based mirror convention as
  // configureColorPickerOpen, needed because the sidebar's Settings
  // subsection and the header's gear dropdown can both be showing this
  // same switch's settings at once.
  let switchTriggerDropdownOpen = null;
  // The shared Break/Hide/Recolor/Move "Trigger on:" picker - same
  // { key, source } shape as switchTriggerDropdownOpen, kept separate
  // from it (rather than reused) only because it reads/writes
  // logicTriggerModes instead of switchTriggerModes/switchEveryTurn.
  let logicTriggerDropdownOpen = null;
  // Every OTHER small options-dropdown across Break/Hide/Recolor/Move
  // (Hide's opacity to/by, Move's Move/Rotate and to/by) shares this
  // one generic slot rather than getting its own variable each -
  // { key, source, field, stepIndex } or null. `field` names which
  // dropdown ('opacityMode' | 'moveAction' | 'moveMode'), `stepIndex`
  // is -1 for the single non-sequenced config or a sequence step's
  // array index, so a step's own copy of a dropdown can be open
  // independently of the base config's copy.
  let logicFieldDropdownOpen = null;

  // The rotation (0-3 quarter-turns) that will be baked into the NEXT
  // structure (including a door - see STRUCTURE_TYPES) placed -
  // cycled by the R hotkey while Place is armed with a structure
  // selected (see the keydown listener near the bottom of this file).
  // Doesn't touch structures already on the map; for now, reorienting
  // an existing one means deleting and re-placing it at the rotation
  // you want. Unlike placeMode/deleteMode/paintMode, this does reset -
  // switching to a different structure type (or a different category
  // entirely) starts back at 0 rather than carrying over whatever was
  // last dialed in for something else (see setSelected).
  let placeRotation = 0;
  function cyclePlaceRotation() {
    placeRotation = (placeRotation + 1) % 4;
    window.BattleMap.requestRedraw(); // so the Place-tool hover ghost reflects the new rotation immediately
  }

  // Toggles whichever tool is currently active between its own two
  // Mode buttons (Q hotkey, below) - same values a click on the
  // header's Mode buttons would set, just without needing the mouse.
  // Place's second mode depends on what's selected (Line for walls,
  // Drag otherwise), same rule the click handler and the swatch-
  // selection code already follow - mirrored here rather than shared,
  // since it's a two-line check.
  function cycleActiveToolMode() {
    if (activeTool === 'select') {
      selectMode = selectMode === 'arrange' ? 'interact' : 'arrange';
      arrangeDragItem = null; // switching mode abandons any drag still in progress
      arrangeDragCurrentInfo = null;
      window.BattleMap.requestRedraw();
    } else if (activeTool === 'place') {
      placeMode = (placeMode === 'click')
        ? ((selected && selected.category === 'wall') ? 'line' : 'drag')
        : 'click';
    } else if (activeTool === 'delete') {
      deleteMode = deleteMode === 'click' ? 'select' : 'click';
    } else if (activeTool === 'paint') {
      paintMode = paintMode === 'click' ? 'drag' : 'click';
    } else if (activeTool === 'configure') {
      configureMode = configureMode === 'edit' ? 'wire' : 'edit';
      cancelPendingWire(); // switching mode abandons any wire still being built, same as closing the tool
    } else {
      return;
    }
    renderHeaderLeft();
  }

  // Line mode (Place, walls only) - the path currently being traced
  // during an active drag, shown as a ghost and only committed to
  // `walls` on release. Empty/null whenever no line drag is in
  // progress. lineEngaged is false when the drag started outside any
  // wall's (now-narrower) hit zone - see resolveWallEdge in map.js -
  // so a drag that never had a valid starting edge doesn't do
  // anything at all, rather than starting from a snapped-to-somewhere
  // guess. lastValidLineTarget carries the most recent real edge seen
  // during the drag, so passing briefly over a dead zone mid-drag (or
  // releasing over one) doesn't lose the line - it just keeps
  // tracing/commits to wherever it last validly was.
  let linePreviewEdges = [];
  let lineWallTypeId = null;
  let lineEngaged = false;
  let lastValidLineTarget = null;

  // Selection mode (Delete) - the rectangle currently being dragged
  // out, in world coordinates. null whenever no selection drag is in
  // progress.
  let selectionRect = null;

  // Header's category/item selector dropdowns (Place only) - at most
  // one open at a time, closed by picking something, reopening the
  // other, or clicking anywhere else (see the document-level click
  // listener near the bottom of this file).
  let categoryDropdownOpen = false;
  let itemDropdownOpen = false;
  // Same idea for Wire mode's own header pair ([ITEM] -> [ITEM]) - the
  // header's compromise version of the sidebar's "+"/"Connected to:"
  // flow, letting the DM pick or change the source without needing the
  // sidebar open at all. Reads/writes the exact same pendingWireSource/
  // pendingWireDestTarget state the sidebar flow uses - this is the
  // same gesture, just a second surface for it.
  let headerWireSourceDropdownOpen = false;
  let headerWireDestDropdownOpen = false;

  // ---------------------------------------------------------------
  // Undo/redo - snapshot-based rather than tracking deltas per
  // action. The whole map's placed content (walls/textures/
  // structures) is small enough that copying all three Maps on every
  // committed action is cheap, and it sidesteps ever having to write
  // (and keep correct) an inverse for each kind of edit. A whole
  // gesture - one paint drag, one line drag, one selection-delete -
  // is a single undo step, not one per cell it touched; see
  // isGestureStart on the info map.js passes to onClick, and the
  // single snapshot taken on a line/select gesture's start/commit.
  // ---------------------------------------------------------------
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO_STEPS = 100;

  function snapshotState() {
    return {
      walls: new Map(walls),
      textures: new Map(textures),
      structures: new Map(structures),
      structureRotations: new Map(structureRotations),
      textureRotations: new Map(textureRotations),
      doors: new Map(doors),
      doorOpenStates: new Map(doorOpenStates),
      leverOnStates: new Map(leverOnStates),
      logic: new Map(logic),
      switchTriggerModes: new Map(switchTriggerModes),
      switchEveryTurn: new Map(switchEveryTurn),
      logicTriggerModes: new Map(logicTriggerModes),
      breakWarning: new Map(breakWarning),
      hideSequence: new Map(hideSequence),
      hideOpacityMode: new Map(hideOpacityMode),
      hideOpacityToValue: new Map(hideOpacityToValue),
      hideOpacityByDirection: new Map(hideOpacityByDirection),
      hideOpacityByValue: new Map(hideOpacityByValue),
      hideReturnOnRetrigger: new Map(hideReturnOnRetrigger),
      hideSequenceSteps: new Map(hideSequenceSteps), // safe as a shallow copy - steps arrays/objects are always replaced, never mutated in place (see the Add Step/edit handlers)
      hideReturnOnLoop: new Map(hideReturnOnLoop),
      recolorSequence: new Map(recolorSequence),
      recolorColors: new Map(recolorColors),
      recolorReturnOnRetrigger: new Map(recolorReturnOnRetrigger),
      recolorSequenceSteps: new Map(recolorSequenceSteps),
      recolorReturnOnLoop: new Map(recolorReturnOnLoop),
      moveSequence: new Map(moveSequence),
      moveAction: new Map(moveAction),
      moveMode: new Map(moveMode),
      moveNewPosition: new Map(moveNewPosition),
      moveAdjust: new Map(moveAdjust),
      moveNewRotation: new Map(moveNewRotation),
      moveRotateAdjustDirection: new Map(moveRotateAdjustDirection),
      moveRotateAdjustStep: new Map(moveRotateAdjustStep),
      moveReturnOnRetrigger: new Map(moveReturnOnRetrigger),
      moveSequenceSteps: new Map(moveSequenceSteps),
      moveReturnOnLoop: new Map(moveReturnOnLoop),
      wires: wires.map((w) => ({ ...w })),
      wallColors: new Map(wallColors),
      textureColors: new Map(textureColors),
      structureColors: new Map(structureColors),
    };
  }
  function restoreState(snap) {
    walls.clear(); for (const [k, v] of snap.walls) walls.set(k, v);
    textures.clear(); for (const [k, v] of snap.textures) textures.set(k, v);
    structures.clear(); for (const [k, v] of snap.structures) structures.set(k, v);
    structureRotations.clear(); for (const [k, v] of snap.structureRotations) structureRotations.set(k, v);
    textureRotations.clear(); for (const [k, v] of snap.textureRotations) textureRotations.set(k, v);
    doors.clear(); for (const [k, v] of snap.doors) doors.set(k, v);
    doorOpenStates.clear(); for (const [k, v] of snap.doorOpenStates) doorOpenStates.set(k, v);
    leverOnStates.clear(); for (const [k, v] of snap.leverOnStates) leverOnStates.set(k, v);
    logic.clear(); for (const [k, v] of snap.logic) logic.set(k, v);
    switchTriggerModes.clear(); for (const [k, v] of snap.switchTriggerModes) switchTriggerModes.set(k, v);
    switchEveryTurn.clear(); for (const [k, v] of snap.switchEveryTurn) switchEveryTurn.set(k, v);
    const restoreMap = (map, snapMap) => { map.clear(); for (const [k, v] of snapMap) map.set(k, v); };
    restoreMap(logicTriggerModes, snap.logicTriggerModes);
    restoreMap(breakWarning, snap.breakWarning);
    restoreMap(hideSequence, snap.hideSequence);
    restoreMap(hideOpacityMode, snap.hideOpacityMode);
    restoreMap(hideOpacityToValue, snap.hideOpacityToValue);
    restoreMap(hideOpacityByDirection, snap.hideOpacityByDirection);
    restoreMap(hideOpacityByValue, snap.hideOpacityByValue);
    restoreMap(hideReturnOnRetrigger, snap.hideReturnOnRetrigger);
    restoreMap(hideSequenceSteps, snap.hideSequenceSteps);
    restoreMap(hideReturnOnLoop, snap.hideReturnOnLoop);
    restoreMap(recolorSequence, snap.recolorSequence);
    restoreMap(recolorColors, snap.recolorColors);
    restoreMap(recolorReturnOnRetrigger, snap.recolorReturnOnRetrigger);
    restoreMap(recolorSequenceSteps, snap.recolorSequenceSteps);
    restoreMap(recolorReturnOnLoop, snap.recolorReturnOnLoop);
    restoreMap(moveSequence, snap.moveSequence);
    restoreMap(moveAction, snap.moveAction);
    restoreMap(moveMode, snap.moveMode);
    restoreMap(moveNewPosition, snap.moveNewPosition);
    restoreMap(moveAdjust, snap.moveAdjust);
    restoreMap(moveNewRotation, snap.moveNewRotation);
    restoreMap(moveRotateAdjustDirection, snap.moveRotateAdjustDirection);
    restoreMap(moveRotateAdjustStep, snap.moveRotateAdjustStep);
    restoreMap(moveReturnOnRetrigger, snap.moveReturnOnRetrigger);
    restoreMap(moveSequenceSteps, snap.moveSequenceSteps);
    restoreMap(moveReturnOnLoop, snap.moveReturnOnLoop);
    wires.length = 0; for (const w of snap.wires) wires.push({ ...w });
    wallColors.clear(); for (const [k, v] of snap.wallColors) wallColors.set(k, v);
    textureColors.clear(); for (const [k, v] of snap.textureColors) textureColors.set(k, v);
    structureColors.clear(); for (const [k, v] of snap.structureColors) structureColors.set(k, v);
  }

  // Cascade for wires - removing any item drops every wire that
  // touches it, whichever end it was on. Called from every deletion
  // site below (single-click delete and Selection-rect delete alike),
  // right next to that item's other per-instance cleanup (colors,
  // rotations, etc.) so a deleted item never leaves a dangling wire
  // behind.
  function removeWiresReferencing(key, category) {
    for (let i = wires.length - 1; i >= 0; i--) {
      const w = wires[i];
      if ((w.fromKey === key && w.fromCategory === category) || (w.toKey === key && w.toCategory === category)) {
        wires.splice(i, 1);
      }
    }
  }
  // Toggles the existing buttons' disabled state directly rather than
  // going through a full renderHeaderLeft() - pushUndoSnapshot() (and
  // therefore this) fires on every single placement/deletion, so a
  // full header rebuild (which also re-renders the tool/mode buttons
  // and reattaches all their listeners) on every one of those would
  // be needless churn for what's ultimately just two boolean flags.
  function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }
  function pushUndoSnapshot() {
    undoStack.push(snapshotState());
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    redoStack.length = 0; // a fresh action invalidates whatever redo history existed
    updateUndoRedoButtons();
  }
  function undo() {
    if (undoStack.length === 0) return;
    redoStack.push(snapshotState());
    restoreState(undoStack.pop());
    window.BattleMap.requestRedraw();
    updateUndoRedoButtons();
    // restoreState only touches the data Maps directly - it doesn't
    // re-render anything on its own. The map picks the change up via
    // requestRedraw(), but the sidebar doesn't - if Configure is open,
    // its color chip/hex text would otherwise keep showing whatever was
    // there right before the undo (e.g. a reset's default color,
    // stuck on-screen even after the override it undid is restored).
    renderDrawTab();
  }
  function redo() {
    if (redoStack.length === 0) return;
    undoStack.push(snapshotState());
    restoreState(redoStack.pop());
    window.BattleMap.requestRedraw();
    updateUndoRedoButtons();
    renderDrawTab(); // same reasoning as undo() above
  }

  const sideScrollEl = document.getElementById('sideScroll');
  const headerLeftEl = document.getElementById('headerLeft');


  function wallKey(edge) {
    return edge.type + ':' + edge.col + ',' + edge.row;
  }
  function parseWallKey(key) {
    const sep = key.indexOf(':');
    const [col, row] = key.slice(sep + 1).split(',').map(Number);
    return { type: key.slice(0, sep), col, row };
  }
  function cellKey(col, row) {
    return col + ',' + row;
  }

  // Structures don't visually fill their whole cell (see the backing-
  // convention notes on drawStairsIcon/drawChestIcon etc. - deliberate,
  // so a texture underneath still peeks through around/between them).
  // This approximates "did the click actually land on the structure's
  // own footprint, or just somewhere else in the same cell" as a
  // simple centered-circle radius rather than exact per-shape hit
  // testing against each structure's own geometry - close enough for
  // every current type (all roughly centered blobs that don't reach
  // the tile edges), and far simpler than re-deriving each one's real
  // outline at click time. Used by Paint so a texture underneath a
  // structure is still reachable by clicking outside that radius - see
  // the 'paint' branch in handleMapClick.
  const STRUCTURE_HIT_RADIUS_FRACTION = 0.35; // of one cell's size, from the cell's center
  // Logic's own on-map footprint is smaller still than a structure's -
  // its backed square is roughly 0.33 of a cell wide (see
  // drawLogicIcon's own LOGIC_ICON_SCALE/LOGIC_SQUARE_PADDING math),
  // so a radius a little over half that (0.18) comfortably covers the
  // icon itself without reaching as far out as a structure's own
  // 0.35 does - confirms the "logic < structure < texture" hit-box
  // ordering the Select tool's Arrange mode relies on to grab any of
  // a cell's three layers independently (texture has no radius check
  // at all here - it's just "anywhere in the cell", the outermost/
  // largest of the three by construction).
  const LOGIC_HIT_RADIUS_FRACTION = 0.18;
  const CELL_SIZE_WORLD = 32; // must match map.js's own CELL_SIZE - world units per cell, used only for this radius check since handleMapClick doesn't get the live `view` object
  function isNearCellCenter(info, radiusFraction) {
    const centerX = (info.col + 0.5) * CELL_SIZE_WORLD;
    const centerY = (info.row + 0.5) * CELL_SIZE_WORLD;
    const dx = info.worldX - centerX, dy = info.worldY - centerY;
    return Math.sqrt(dx * dx + dy * dy) <= radiusFraction * CELL_SIZE_WORLD;
  }

  // What Arrange mode would actually pick up from a given spot -
  // { category, key, typeId } for whichever layer is topmost there,
  // or null if nothing's grabbable. Edge occupants (logic-on-an-edge,
  // door, wall) take priority over the cell they border, same
  // convention as everywhere else; among a cell's own three layers,
  // logic needs the click within its own (smaller) radius, structure
  // within its own (larger) radius, and texture has no radius at all -
  // it's the whole cell, being the outermost/largest by construction.
  function findGrabbableAt(info) {
    const eKey = info.edge ? wallKey(info.edge) : null;
    if (eKey) {
      if (logic.has(eKey)) return { category: 'logic', key: eKey, typeId: logic.get(eKey) };
      if (doors.has(eKey)) return { category: 'structure', key: eKey, typeId: 'door' };
      if (walls.has(eKey)) return { category: 'wall', key: eKey, typeId: walls.get(eKey) };
    }
    const cKey = cellKey(info.col, info.row);
    if (logic.has(cKey) && isNearCellCenter(info, LOGIC_HIT_RADIUS_FRACTION)) {
      return { category: 'logic', key: cKey, typeId: logic.get(cKey) };
    }
    if (structures.has(cKey) && isNearCellCenter(info, STRUCTURE_HIT_RADIUS_FRACTION)) {
      return { category: 'structure', key: cKey, typeId: structures.get(cKey) };
    }
    if (textures.has(cKey)) {
      return { category: 'texture', key: cKey, typeId: textures.get(cKey) };
    }
    return null;
  }

  // Repoints every wire touching a moved item's OLD key to its new
  // one - both ends, since either could reference it. Category never
  // actually changes in a move, just the key, but takes both anyway
  // for symmetry with how every other per-endpoint update in this
  // file works.
  function updateWireReferences(oldKey, oldCategory, newKey, newCategory) {
    for (const w of wires) {
      if (w.fromKey === oldKey && w.fromCategory === oldCategory) {
        w.fromKey = newKey; w.fromCategory = newCategory;
      }
      if (w.toKey === oldKey && w.toCategory === oldCategory) {
        w.toKey = newKey; w.toCategory = newCategory;
      }
    }
  }

  // Moves whatever findGrabbableAt found from its old key to a new
  // one, carrying over every per-instance thing that goes with it
  // (color, rotation, on/off state, trigger wiring) rather than
  // resetting to defaults the way a brand new placement would - this
  // is the same object relocating, not a delete-then-place. Wall/door
  // placement's own "replaces whatever was on the other side" rule
  // applies at the DESTINATION too, same as a fresh placement there
  // would. Finishes by repointing any wires that referenced the old
  // key - the whole reason Arrange mode exists as its own thing
  // rather than just Delete-then-Place.
  function moveItem(item, newKey) {
    const oldKey = item.key;
    // Dropping onto an occupied destination replaces whatever was
    // there, same as a fresh placement would - and same as a fresh
    // placement's own delete-then-place, that destroyed occupant's
    // wires need to go with it rather than dangling. Wall and door
    // share one edge slot (mutually exclusive - see the maps
    // themselves), so both categories are checked defensively
    // regardless of which one actually occupied it; the other is a
    // harmless no-op since nothing there would match.
    if (item.category === 'wall' || item.typeId === 'door') {
      removeWiresReferencing(newKey, 'wall');
      removeWiresReferencing(newKey, 'structure');
    } else {
      removeWiresReferencing(newKey, item.category);
    }
    if (item.category === 'wall') {
      const typeId = walls.get(oldKey);
      const color = wallColors.get(oldKey);
      walls.delete(oldKey); wallColors.delete(oldKey);
      doors.delete(newKey); structureColors.delete(newKey); doorOpenStates.delete(newKey);
      wallColors.delete(newKey); // clears the DESTINATION's own stale color - otherwise a moved wall with no override of its own would silently inherit whatever was already sitting there
      walls.set(newKey, typeId);
      if (color) wallColors.set(newKey, color);
    } else if (item.typeId === 'door') {
      const rotation = doors.get(oldKey);
      const color = structureColors.get(oldKey);
      const isOpen = doorOpenStates.get(oldKey);
      doors.delete(oldKey); structureColors.delete(oldKey); doorOpenStates.delete(oldKey);
      walls.delete(newKey); wallColors.delete(newKey);
      structureColors.delete(newKey); doorOpenStates.delete(newKey); // clears the DESTINATION door's own stale color/open-state
      doors.set(newKey, rotation);
      if (color) structureColors.set(newKey, color);
      if (isOpen) doorOpenStates.set(newKey, isOpen);
    } else if (item.category === 'structure') {
      const typeId = structures.get(oldKey);
      const rotation = structureRotations.get(oldKey);
      const color = structureColors.get(oldKey);
      const isOn = leverOnStates.get(oldKey);
      structures.delete(oldKey); structureRotations.delete(oldKey); structureColors.delete(oldKey); leverOnStates.delete(oldKey);
      structureRotations.delete(newKey); structureColors.delete(newKey); leverOnStates.delete(newKey); // clears the DESTINATION structure's own stale rotation/color/on-state
      structures.set(newKey, typeId);
      if (rotation) structureRotations.set(newKey, rotation);
      if (color) structureColors.set(newKey, color);
      if (isOn) leverOnStates.set(newKey, isOn);
    } else if (item.category === 'texture') {
      const typeId = textures.get(oldKey);
      const color = textureColors.get(oldKey);
      const rotation = textureRotations.get(oldKey);
      textures.delete(oldKey); textureColors.delete(oldKey); textureRotations.delete(oldKey);
      textureColors.delete(newKey); textureRotations.delete(newKey); // clears the DESTINATION texture's own stale color/rotation
      textures.set(newKey, typeId);
      if (color) textureColors.set(newKey, color);
      if (rotation) textureRotations.set(newKey, rotation);
    } else if (item.category === 'logic') {
      const typeId = logic.get(oldKey);
      // Every per-instance Logic setting a piece could have, across all
      // five types - only the ones that actually apply to this key's
      // typeId will ever be populated, but carrying the whole list is
      // simpler and safer than a per-type branch here, and harmless for
      // the rest (same "unused, not wrong" reasoning as leverOnStates
      // being carried on a non-lever structure elsewhere in this
      // function). See LOGIC_INSTANCE_MAPS for the shared list.
      const carried = LOGIC_INSTANCE_MAPS.map((map) => map.get(oldKey));
      logic.delete(oldKey);
      LOGIC_INSTANCE_MAPS.forEach((map) => map.delete(oldKey));
      LOGIC_INSTANCE_MAPS.forEach((map) => map.delete(newKey)); // clears the DESTINATION's own stale settings
      logic.set(newKey, typeId);
      LOGIC_INSTANCE_MAPS.forEach((map, i) => { if (carried[i] !== undefined) map.set(newKey, carried[i]); });
    }
    updateWireReferences(oldKey, item.category, newKey, item.category);
  }

  // Select tool's Arrange mode - driven by map.js's 'arrange' drag
  // gesture (see syncDragBehavior), which gives the same start/
  // update/commit phases Line/Selection already use. 'start' picks up
  // whatever's grabbable at the press point (see findGrabbableAt) and
  // nothing else happens if there isn't one; 'update' just tracks the
  // cursor for the ghost preview (see renderOverlay); 'commit'
  // resolves a real drop target per the grabbed item's own category
  // (edge-bound things need a real edge; logic takes whichever the
  // drop point actually resolved to; everything else is cell-bound)
  // and actually moves it there, or quietly does nothing if the drop
  // has no valid target for that category, or if it's the same spot
  // it started at.
  function handleArrangeGesture(startInfo, currentInfo, phase) {
    if (phase === 'start') {
      arrangeDragItem = findGrabbableAt(startInfo);
      arrangeDragCurrentInfo = arrangeDragItem ? startInfo : null;
      if (arrangeDragItem) window.BattleMap.requestRedraw();
      return;
    }
    if (phase === 'update') {
      if (!arrangeDragItem) return;
      arrangeDragCurrentInfo = currentInfo;
      window.BattleMap.requestRedraw();
      return;
    }
    // commit
    if (!arrangeDragItem) return;
    const item = arrangeDragItem;
    arrangeDragItem = null;
    arrangeDragCurrentInfo = null;

    let newKey;
    if (item.category === 'wall' || item.typeId === 'door') {
      if (!currentInfo.edge) { window.BattleMap.requestRedraw(); return; } // no edge under the drop point - nothing to move to, leave it where it was
      newKey = wallKey(currentInfo.edge);
    } else if (item.category === 'logic') {
      newKey = currentInfo.edge ? wallKey(currentInfo.edge) : cellKey(currentInfo.col, currentInfo.row);
    } else {
      newKey = cellKey(currentInfo.col, currentInfo.row);
    }

    if (newKey === item.key) { window.BattleMap.requestRedraw(); return; } // dropped back where it started

    pushUndoSnapshot();
    moveItem(item, newKey);
    window.BattleMap.requestRedraw();
    renderDrawTab();
    renderHeaderLeft();
  }

  function typeList(category) {
    return category === 'wall' ? WALL_TYPES : category === 'texture' ? TEXTURE_TYPES : category === 'logic' ? LOGIC_TYPES : STRUCTURE_TYPES;
  }
  function findType(category, id) {
    return typeList(category).find((t) => t.id === id);
  }

  // ---------------------------------------------------------------
  // Line mode - traces a path of wall edges approximating a straight
  // line between two grid vertices. Walls only exist as horizontal or
  // vertical segments, so this can't move diagonally like a normal
  // Bresenham line would on a "diagonal" point of the ideal line -
  // instead it takes the two orthogonal unit steps separately,
  // producing a staircase that hugs the true line as closely as an
  // axis-aligned path can.
  // ---------------------------------------------------------------
  function edgeVertex(edge) {
    // Both edge orientations happen to share (col, row) as one of
    // their two endpoints, so this works for either without a branch.
    return { x: edge.col, y: edge.row };
  }

  // An edge's two actual endpoint vertices - used for picking which
  // one to trace TO (see farthestVertexFrom) rather than always
  // assuming (col, row), which is only correct when dragging in one
  // particular direction.
  function edgeVertices(edge) {
    if (edge.type === 'h') return [{ x: edge.col, y: edge.row }, { x: edge.col + 1, y: edge.row }];
    return [{ x: edge.col, y: edge.row }, { x: edge.col, y: edge.row + 1 }];
  }

  // Which of an edge's two vertices to trace the line TO, so the
  // traced path actually reaches all the way through the hovered edge
  // instead of stopping one edge short of it. edgeVertex() always
  // used the edge's (col, row) corner regardless of drag direction -
  // fine when dragging toward increasing col/row, but for the
  // opposite direction that's the NEAR corner, so the trace would
  // stop right at the hovered edge's near end without ever actually
  // including it. The far corner (relative to the drag's start) is
  // the one that's correct in every direction.
  function farthestVertexFrom(edge, from) {
    const [v1, v2] = edgeVertices(edge);
    const d1 = Math.hypot(v1.x - from.x, v1.y - from.y);
    const d2 = Math.hypot(v2.x - from.x, v2.y - from.y);
    return d1 >= d2 ? v1 : v2;
  }

  function edgeBetweenVertices(ax, ay, bx, by) {
    if (ay === by) return { type: 'h', col: Math.min(ax, bx), row: ay };
    return { type: 'v', col: ax, row: Math.min(ay, by) };
  }

  function traceEdgePath(x0, y0, x1, y1) {
    const edges = [];
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let cx = x0, cy = y0;

    while (cx !== x1 || cy !== y1) {
      const e2 = 2 * err;
      let moved = false;
      if (e2 >= dy) {
        err += dy;
        edges.push(edgeBetweenVertices(cx, cy, cx + sx, cy));
        cx += sx;
        moved = true;
      }
      if (e2 <= dx) {
        err += dx;
        edges.push(edgeBetweenVertices(cx, cy, cx, cy + sy));
        cy += sy;
        moved = true;
      }
      if (!moved) break; // safety net - shouldn't be reachable
    }
    return edges;
  }


  // ---------------------------------------------------------------
  // Placement / deletion - map.js calls this for every genuine click
  // (not a pan drag) anywhere on the map.
  // ---------------------------------------------------------------
  function handleMapClick(info) {
    if (activeTool === 'select') {
      // Arrange mode doesn't use this at all - it's driven by the
      // map's own 'arrange' drag gesture instead (see
      // handleArrangeGesture), which fires on genuine drags, not the
      // plain clicks this function handles. Interact activates
      // whatever structure (door included, since it's a structure
      // type living on an edge) is at the click - same edge-first,
      // then within-radius-of-cell-center priority Paint/Delete/
      // Arrange all already use, so a click doesn't accidentally
      // activate a structure two cells away just because reaching it
      // by scanning the cell without a radius would resolve there.
      // Only lever and door have any effect yet - "we'll get to what
      // [other] structures do soon" is still true here.
      if (selectMode !== 'interact') return;
      const eKey = info.edge ? wallKey(info.edge) : null;
      if (eKey && doors.has(eKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        doorOpenStates.set(eKey, !doorOpenStates.get(eKey));
        window.BattleMap.requestRedraw();
        return;
      }
      const cKey = cellKey(info.col, info.row);
      if (structures.has(cKey) && isNearCellCenter(info, STRUCTURE_HIT_RADIUS_FRACTION)) {
        if (structures.get(cKey) === 'lever') {
          if (info.isGestureStart) pushUndoSnapshot();
          leverOnStates.set(cKey, !leverOnStates.get(cKey));
          window.BattleMap.requestRedraw();
        }
      }
      return;
    }
    if (activeTool === 'configure') {
      // Records where was clicked so renderConfigurePanel can look up
      // what's there. Only ONE of edge/cell is treated as the actual
      // target - edge wins when the click resolved close enough to one
      // (same edge-takes-priority-over-the-cell convention Paint/Delete
      // already use), otherwise it's a plain tile click. Still stores
      // both col/row and edge (computeCellInfo always computes both),
      // but renderConfigurePanel/the map overlay only look at one side
      // of it - see the `configureTarget.edge` checks there. This used
      // to surface a tile's contents AND its nearest edge's contents at
      // once; per explicit feedback, only one target should be pickable
      // at a time.
      //
      // While a wire is actively being built (Wire mode, a source
      // already picked), a click picks the DESTINATION location
      // instead of moving the sidebar's own focus - configureTarget
      // deliberately stays put on the source's location the whole
      // time, per the person's own spec ("It should remain focused on
      // the location originally selected... After which, the original
      // location remains highlighted and focused on"). Left-click here
      // is just this bookkeeping (matches Edit mode's own plain
      // select-and-highlight) - the actual item picker only opens on
      // right-click now (see the onContextMenu handler below), not on
      // every left-click the way it used to.
      if (configureMode === 'wire' && pendingWireSource) {
        pendingWireDestTarget = { col: info.col, row: info.row, edge: info.edge };
      } else {
        configureTarget = { col: info.col, row: info.row, edge: info.edge };
      }
      renderDrawTab();
      renderHeaderLeft(); // the header's own destination box enables/repopulates off pendingWireDestTarget too
      window.BattleMap.requestRedraw(); // the map-side highlight (see renderOverlay) needs to move too
      return;
    }

    if (activeTool === 'paint') {
      // Same edges-take-priority-over-the-cell convention as Delete/
      // Configure - it's the more specific of the two possible targets.
      // A door is a structure (structureColors, edge-keyed) rather than
      // a wall (wallColors) - see the color system notes on doors.
      const wKey = info.edge ? wallKey(info.edge) : null;
      if (wKey && doors.has(wKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        structureColors.set(wKey, { primary: paintPrimaryColor, secondary: paintSecondaryColor });
        window.BattleMap.requestRedraw();
        return;
      }
      if (wKey && walls.has(wKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        wallColors.set(wKey, { primary: paintPrimaryColor }); // walls have no secondary yet
        window.BattleMap.requestRedraw();
        return;
      }
      // Structures take priority over the texture they sit on, but
      // only when the click actually lands on the structure's own
      // (approximate) footprint - they don't fill the whole cell, so
      // clicking elsewhere in the same cell should still reach the
      // texture underneath. See isNearCellCenter/
      // STRUCTURE_HIT_RADIUS_FRACTION. This was the substantial gap:
      // structures already have a real primary/secondary color system
      // (Configure can recolor them) but Paint never wrote to it -
      // structureColors was only ever read here, never set.
      const cKey = cellKey(info.col, info.row);
      if (structures.has(cKey) && isNearCellCenter(info, STRUCTURE_HIT_RADIUS_FRACTION)) {
        if (info.isGestureStart) pushUndoSnapshot();
        structureColors.set(cKey, { primary: paintPrimaryColor, secondary: paintSecondaryColor });
        window.BattleMap.requestRedraw();
        return;
      }
      if (textures.has(cKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        textureColors.set(cKey, { primary: paintPrimaryColor, secondary: paintSecondaryColor });
        window.BattleMap.requestRedraw();
      }
      return;
    }

    if (activeTool === 'delete') {
      // Edges take priority over the cell they border - a click can
      // be "close enough" to both a wall/door and a texture at once,
      // and the edge is the more specific/deliberate target of the
      // two. A wall and a door can never share an edge (see
      // placement below), so checking both here is just covering
      // both possible edge occupants, not a priority order between
      // them. Logic is checked first on both the edge and cell side -
      // it renders on top of everything else, so a click there most
      // likely means the logic piece, not whatever's underneath it.
      const wKey = info.edge ? wallKey(info.edge) : null;
      if (wKey && logic.has(wKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        logic.delete(wKey);
        LOGIC_INSTANCE_MAPS.forEach((map) => map.delete(wKey));
        removeWiresReferencing(wKey, 'logic');
        window.BattleMap.requestRedraw();
        return;
      }
      if (wKey && doors.has(wKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        doors.delete(wKey);
        structureColors.delete(wKey);
        doorOpenStates.delete(wKey);
        removeWiresReferencing(wKey, 'structure');
        window.BattleMap.requestRedraw();
        return;
      }
      if (wKey && walls.has(wKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        walls.delete(wKey);
        wallColors.delete(wKey);
        removeWiresReferencing(wKey, 'wall');
        window.BattleMap.requestRedraw();
        return;
      }
      const cKey = cellKey(info.col, info.row);
      if (logic.has(cKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        logic.delete(cKey);
        LOGIC_INSTANCE_MAPS.forEach((map) => map.delete(cKey));
        removeWiresReferencing(cKey, 'logic');
        window.BattleMap.requestRedraw();
        return;
      }
      if (structures.has(cKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        structures.delete(cKey);
        structureRotations.delete(cKey);
        structureColors.delete(cKey);
        leverOnStates.delete(cKey);
        removeWiresReferencing(cKey, 'structure');
        window.BattleMap.requestRedraw();
        return;
      }
      if (textures.has(cKey)) {
        if (info.isGestureStart) pushUndoSnapshot();
        textures.delete(cKey);
        textureColors.delete(cKey);
        textureRotations.delete(cKey);
        removeWiresReferencing(cKey, 'texture');
        window.BattleMap.requestRedraw();
      }
      return;
    }

    if (activeTool !== 'place' || !selected) return;

    if (selected.category === 'wall') {
      if (!info.edge) return; // click landed outside every wall's hit zone - not a valid target, do nothing rather than guess
      if (info.isGestureStart) pushUndoSnapshot();
      const eKey = wallKey(info.edge);
      walls.set(eKey, selected.id);
      wallColors.delete(eKey); // a newly placed item always starts at default colors, never inheriting whatever used to be here
    } else if (selected.category === 'texture') {
      if (info.isGestureStart) pushUndoSnapshot();
      const cKey = cellKey(info.col, info.row);
      textures.set(cKey, selected.id);
      textureColors.delete(cKey);
      textureRotations.set(cKey, placeRotation);
    } else if (selected.category === 'logic') {
      // The one category that can land on either target - edge wins
      // when the click is close enough to one (same convention as
      // Paint/Delete/Configure), otherwise it's a plain tile piece.
      if (info.isGestureStart) pushUndoSnapshot();
      const key = info.edge ? wallKey(info.edge) : cellKey(info.col, info.row);
      logic.set(key, selected.id);
      LOGIC_INSTANCE_MAPS.forEach((map) => map.delete(key)); // a newly placed item always starts at default settings (harmless no-op for whichever maps don't apply to this typeId)
    } else if (selected.category === 'structure') {
      if (selected.id === 'door') {
        // Doors sit on an edge, same as a wall - not centered in a
        // cell like every other structure - so this targets
        // info.edge instead of info.col/info.row, and clears
        // whatever wall was on that edge first (a door replaces a
        // wall, it doesn't sit on top of one).
        if (!info.edge) return;
        if (info.isGestureStart) pushUndoSnapshot();
        const eKey = wallKey(info.edge);
        walls.delete(eKey);
        wallColors.delete(eKey);
        doors.set(eKey, placeRotation);
        structureColors.delete(eKey);
        doorOpenStates.delete(eKey); // a newly placed door always starts closed
      } else {
        if (info.isGestureStart) pushUndoSnapshot();
        const cKey = cellKey(info.col, info.row);
        structures.set(cKey, selected.id);
        structureRotations.set(cKey, placeRotation);
        structureColors.delete(cKey);
        leverOnStates.delete(cKey); // a newly placed lever always starts off (harmless no-op for other types)
      }
    }
    window.BattleMap.requestRedraw();
  }

  // ---------------------------------------------------------------
  // Line mode - map.js calls this on start/update/commit while
  // dragging with Place armed for a wall and Line mode selected. The
  // first wall (wherever the drag started) is placed immediately,
  // same as a normal click; everything after that is preview-only
  // (see linePreviewEdges, drawn by renderOverlay) until release,
  // when the whole traced path gets committed at once.
  // ---------------------------------------------------------------
  function handleLineGesture(startInfo, currentInfo, phase) {
    if (!selected || selected.category !== 'wall') return; // shouldn't happen - syncDragBehavior only arms 'line' for wall selections

    if (phase === 'start') {
      if (!startInfo.edge) {
        // Drag started outside every wall's hit zone - there's
        // nothing to anchor a line to, so the gesture just doesn't
        // engage at all rather than guessing a nearby edge.
        lineEngaged = false;
        return;
      }
      lineEngaged = true;
      lastValidLineTarget = startInfo;
      pushUndoSnapshot(); // the whole line (this first wall plus everything traced during the drag) undoes as one step
      lineWallTypeId = selected.id;
      const startKey = wallKey(startInfo.edge);
      walls.set(startKey, lineWallTypeId);
      wallColors.delete(startKey);
      linePreviewEdges = [];
      window.BattleMap.requestRedraw();
      return;
    }

    if (!lineEngaged) return; // start never landed on a valid edge - ignore the rest of this drag

    // A mid-drag or release point that isn't over a valid edge keeps
    // tracing toward wherever it last validly was, rather than losing
    // the line or snapping somewhere unintended.
    const target = currentInfo.edge ? currentInfo : lastValidLineTarget;
    if (currentInfo.edge) lastValidLineTarget = currentInfo;

    const startVertex = edgeVertex(startInfo.edge);
    const endVertex = farthestVertexFrom(target.edge, startVertex);
    const path = traceEdgePath(startVertex.x, startVertex.y, endVertex.x, endVertex.y);

    if (phase === 'update') {
      linePreviewEdges = path;
      window.BattleMap.requestRedraw();
      return;
    }

    // commit
    for (const edge of path) {
      const eKey = wallKey(edge);
      walls.set(eKey, lineWallTypeId);
      wallColors.delete(eKey);
    }
    linePreviewEdges = [];
    lineEngaged = false;
    window.BattleMap.requestRedraw();
  }

  // ---------------------------------------------------------------
  // Selection mode - map.js calls this on start/update/commit while
  // dragging with Delete armed and Selection mode selected. Nothing
  // is deleted until release, when everything found inside the final
  // rectangle goes at once.
  // ---------------------------------------------------------------
  function handleSelectGesture(startInfo, currentInfo, phase) {
    if (phase === 'start') {
      selectionRect = { x1: startInfo.worldX, y1: startInfo.worldY, x2: startInfo.worldX, y2: startInfo.worldY };
      window.BattleMap.requestRedraw();
      return;
    }
    if (phase === 'update') {
      selectionRect.x2 = currentInfo.worldX;
      selectionRect.y2 = currentInfo.worldY;
      window.BattleMap.requestRedraw();
      return;
    }

    // commit
    const minCol = Math.min(startInfo.col, currentInfo.col);
    const maxCol = Math.max(startInfo.col, currentInfo.col);
    const minRow = Math.min(startInfo.row, currentInfo.row);
    const maxRow = Math.max(startInfo.row, currentInfo.row);

    pushUndoSnapshot(); // the whole rectangle's worth of deletions undoes as one step

    // Horizontal and vertical edges use mirror-image key schemas (see
    // wallKey's own comment): a horizontal edge's `col` is a cell-column
    // index and its `row` is a grid-line index, while for a vertical
    // edge it's the other way around. So the "+1 tolerant" boundary -
    // needed because an edge sitting on the selection's far side still
    // borders a cell that's inside it - only actually applies on the
    // grid-line axis for that edge's own type. Padding the CELL-index
    // axis by +1 as well (as a type-blind check would) catches walls
    // one whole cell past the selection on that axis - exactly the
    // "deletes walls merely adjacent to a selected tile" bug reported.
    for (const key of [...walls.keys()]) {
      const edge = parseWallKey(key);
      const colMax = edge.type === 'v' ? maxCol + 1 : maxCol;
      const rowMax = edge.type === 'h' ? maxRow + 1 : maxRow;
      if (edge.col >= minCol && edge.col <= colMax && edge.row >= minRow && edge.row <= rowMax) {
        walls.delete(key);
        wallColors.delete(key);
        removeWiresReferencing(key, 'wall');
      }
    }
    for (const key of [...doors.keys()]) {
      const edge = parseWallKey(key);
      const colMax = edge.type === 'v' ? maxCol + 1 : maxCol;
      const rowMax = edge.type === 'h' ? maxRow + 1 : maxRow;
      if (edge.col >= minCol && edge.col <= colMax && edge.row >= minRow && edge.row <= rowMax) {
        doors.delete(key);
        structureColors.delete(key);
        doorOpenStates.delete(key);
        removeWiresReferencing(key, 'structure');
      }
    }
    for (const key of [...textures.keys()]) {
      const [c, r] = key.split(',').map(Number);
      if (c >= minCol && c <= maxCol && r >= minRow && r <= maxRow) {
        textures.delete(key);
        textureColors.delete(key);
        textureRotations.delete(key);
        removeWiresReferencing(key, 'texture');
      }
    }
    for (const key of [...structures.keys()]) {
      const [c, r] = key.split(',').map(Number);
      if (c >= minCol && c <= maxCol && r >= minRow && r <= maxRow) {
        structures.delete(key);
        structureRotations.delete(key);
        structureColors.delete(key);
        leverOnStates.delete(key);
        removeWiresReferencing(key, 'structure');
      }
    }
    // Logic - mixed key shapes (edge or cell, see the `logic` Map's
    // own comment), so each key needs its own check against whichever
    // bounds actually apply to it. This was missing entirely before -
    // Selection deleted everything else in the rectangle but silently
    // left any Logic pieces behind.
    for (const key of [...logic.keys()]) {
      if (key.indexOf(':') !== -1) {
        const edge = parseWallKey(key);
        const colMax = edge.type === 'v' ? maxCol + 1 : maxCol;
        const rowMax = edge.type === 'h' ? maxRow + 1 : maxRow;
        if (edge.col >= minCol && edge.col <= colMax && edge.row >= minRow && edge.row <= rowMax) {
          logic.delete(key);
          LOGIC_INSTANCE_MAPS.forEach((map) => map.delete(key));
          removeWiresReferencing(key, 'logic');
        }
      } else {
        const [c, r] = key.split(',').map(Number);
        if (c >= minCol && c <= maxCol && r >= minRow && r <= maxRow) {
          logic.delete(key);
          LOGIC_INSTANCE_MAPS.forEach((map) => map.delete(key));
          removeWiresReferencing(key, 'logic');
        }
      }
    }

    selectionRect = null;
    window.BattleMap.requestRedraw();
  }

  // ---------------------------------------------------------------
  // Shape math shared between the map overlay and the sidebar swatch
  // previews, so a wall/texture looks the same in both places by
  // construction instead of by two hand-matched implementations.
  // ---------------------------------------------------------------

  // Builds a wavering path of alternating/sinusoidal offsets from
  // (x1,y1) to (x2,y2) - used for both zigzag and wavy walls, which
  // differ only in whether the offset switches abruptly (a true
  // triangle wave - straight segments between alternating peaks) or
  // eases through a sine curve.
  //
  // The number of periods is locked to a whole number (based on the
  // requested wavelength, rounded) rather than stepping in fixed
  // world-unit increments. That guarantees the path always starts and
  // ends exactly at offset 0 - on the real vertex - instead of
  // landing mid-wave and needing an artificial straight-line "foot"
  // snapped back onto the true endpoint, which is what the previous
  // version did. Since wavelength is passed in already scaled by the
  // current zoom (same as the edge length itself, one grid cell),
  // that ratio is a stable, zoom-invariant integer rather than a
  // value that drifts near a rounding boundary - that's what stopped
  // the shape from abruptly reshaping mid-zoom, not just the
  // start/end fix on its own.
  function buildWaveringPoints(x1, y1, x2, y2, wavelength, amplitude, smooth) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 1) return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
    const ux = dx / length;
    const uy = dy / length;
    const px = -uy; // perpendicular unit vector
    const py = ux;

    const periods = Math.max(1, Math.round(length / wavelength));
    const points = [];

    if (smooth) {
      const stepsPerPeriod = 10; // enough segments per period to read as a smooth curve
      const totalSteps = periods * stepsPerPeriod;
      for (let i = 0; i <= totalSteps; i++) {
        const t = (i / totalSteps) * length;
        const angle = (i / stepsPerPeriod) * Math.PI * 2;
        const offset = Math.sin(angle) * amplitude;
        points.push({ x: x1 + ux * t + px * offset, y: y1 + uy * t + py * offset });
      }
    } else {
      // True triangle wave: 0 -> +amp -> 0 -> -amp -> 0 per period,
      // one quarter-step at a time - straight segments connecting
      // alternating peaks, which is what a zigzag actually is,
      // rather than the square-wave-derived shape (offset jumping
      // straight between the two extremes with nothing at zero) the
      // previous version produced.
      const quarterSteps = periods * 4;
      const triangleValues = [0, 1, 0, -1];
      for (let i = 0; i <= quarterSteps; i++) {
        const t = (i / quarterSteps) * length;
        const offset = triangleValues[i % 4] * amplitude;
        points.push({ x: x1 + ux * t + px * offset, y: y1 + uy * t + py * offset });
      }
    }
    return points;
  }

  function strokePath(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  function drawWallSegment(ctx, edge, type, view, alpha, overrideColor) {
    const cell = view.cellSize * view.zoom;
    let x1, y1, x2, y2;
    if (edge.type === 'h') {
      x1 = view.offsetX + edge.col * cell; y1 = view.offsetY + edge.row * cell;
      x2 = view.offsetX + (edge.col + 1) * cell; y2 = y1;
    } else {
      x1 = view.offsetX + edge.col * cell; y1 = view.offsetY + edge.row * cell;
      x2 = x1; y2 = view.offsetY + (edge.row + 1) * cell;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = overrideColor || WALL_COLOR;
    ctx.lineWidth = Math.max(2, cell * 0.08);
    ctx.lineCap = type.id === 'dotted' ? 'round' : 'square';
    ctx.lineJoin = 'round';

    if (type.pattern === 'zigzag' || type.pattern === 'wavy') {
      ctx.setLineDash([]);
      const wavelength = 16 * view.zoom;
      const amplitude = 4 * view.zoom;
      const points = buildWaveringPoints(x1, y1, x2, y2, wavelength, amplitude, type.pattern === 'wavy');
      strokePath(ctx, points);
    } else {
      ctx.setLineDash((type.dash || []).map((d) => d * view.zoom));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function cellRect(col, row, view) {
    const cell = view.cellSize * view.zoom;
    return { x: view.offsetX + col * cell, y: view.offsetY + row * cell, size: cell };
  }

  function drawTexture(ctx, rect, type, rotation, view, alpha, overrideColor, overrideSecondary) {
    const { x, y, size } = rect;
    const cx = x + size / 2, cy = y + size / 2;
    const color = overrideColor || type.color;
    ctx.save();
    ctx.globalAlpha = alpha;
    // A 90-degree-multiple square rotated about its own center is the
    // same square, so rotating before the clip/fill below (rather than
    // needing a separate un-rotated clip step) is safe - only the
    // pattern drawn inside actually looks different per rotation
    // (diagonal/dotted/wavy read differently; solid/cracked don't, but
    // harmlessly carry a rotation value anyway).
    ctx.translate(cx, cy);
    ctx.rotate(((rotation || 0) % 4) * (Math.PI / 2));
    ctx.translate(-cx, -cy);
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();

    // Secondary is "the rest of the floor" behind the pattern - only
    // painted when a per-instance secondary color actually exists;
    // the default rendering stays transparent (showing the map
    // background through), same as it always has.
    if (overrideSecondary) {
      ctx.fillStyle = overrideSecondary;
      ctx.fillRect(x, y, size, size);
    }

    if (type.pattern === 'solid') {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, size, size);
    } else if (type.pattern === 'diagonal') {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, size * 0.045);
      const spacing = size / 6;
      for (let o = -size; o < size * 2; o += spacing) {
        ctx.beginPath();
        ctx.moveTo(x + o, y);
        ctx.lineTo(x + o + size, y + size);
        ctx.stroke();
      }
    } else if (type.pattern === 'dotted') {
      // The same repeating diagonal band layout as the diagonal
      // texture above - just dashed into round dots instead of a
      // continuous stroke, so it reads as the same family of pattern
      // rather than an unrelated grid of dots.
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      const dotWidth = Math.max(1.5, size * 0.06);
      ctx.lineWidth = dotWidth;
      ctx.setLineDash([0.01, size * 0.1]);
      const spacing = size / 6;
      for (let o = -size; o < size * 2; o += spacing) {
        ctx.beginPath();
        ctx.moveTo(x + o, y);
        ctx.lineTo(x + o + size, y + size);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    } else if (type.pattern === 'wavy') {
      // Same diagonal-band layout again, each band wobbling
      // perpendicular to its own direction instead of running
      // straight - the textured-surface counterpart to the wavy wall.
      // The wobble's phase is locked to a whole number of periods
      // over each band's own t=0..1 span (same fix as the wavy
      // wall) - every band shares the identical phase-vs-t function
      // regardless of its offset, so this one fix makes every band
      // start and end at wobble=0, reaching flush to the cell's true
      // edges instead of falling short.
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, size * 0.04);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const spacing = size / 4; // was size/6 - about a third fewer lines
      const amplitude = size * 0.045;
      const periods = 2; // fewer, gentler undulations per line - less rigid/busy than before
      const steps = 24; // more points per line than before for a visibly smoother curve
      const nx = 0.7071, ny = -0.7071; // unit vector perpendicular to the diagonal's own (1,1) direction
      for (let o = -size; o < size * 2; o += spacing) {
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const baseX = x + o + t * size;
          const baseY = y + t * size;
          const wobble = Math.sin(t * periods * Math.PI * 2) * amplitude;
          const px = baseX + nx * wobble;
          const py = baseY + ny * wobble;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    } else if (type.pattern === 'cracked') {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const crack of CRACK_DEFS) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, size * 0.035);
        ctx.beginPath();
        crack.main.forEach(([fx, fy], i) => {
          const px = x + fx * size;
          const py = y + fy * size;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.stroke();

        // Branches read as secondary fractures splitting off the
        // main crack - thinner than it, same color.
        ctx.lineWidth = Math.max(0.75, size * 0.022);
        for (const branch of crack.branches) {
          ctx.beginPath();
          branch.forEach(([fx, fy], i) => {
            const px = x + fx * size;
            const py = y + fy * size;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------
  // Structures - the third placed-content layer, drawn over textures
  // (see renderOverlay). Unlike an earlier version of this, there's no
  // whole-cell background fill anymore - that obscured neighboring
  // grid borders and hid textures it had no business hiding. Instead,
  // only the pieces of each icon that actually need to read as solid
  // (the chest's box/latch, the stairs' arrow) get their own tightly-
  // fitted opaque backing; thin line work (the stairs' 6 lines) is
  // just ink, same as a wall or texture line, so a texture underneath
  // stays visible around and between them. Each type gets a bespoke
  // icon function rather than a shared parametric drawer, since
  // "stairs" and "chest" don't share a pattern vocabulary the way
  // wall/texture styles do.
  // ---------------------------------------------------------------

  // 6 vertical lines increasing in length at a linear rate, left to
  // right - the last one spanning the icon's full usable height edge
  // to edge - plus a vertical up/down arrow. The two rotate
  // independently: the lines are the "image" and spin a full 90
  // degrees per rotation step; the arrow only ever points straight up
  // or straight down and never spins itself - it just flips direction
  // once, at rotation 2. So: rotation 0 = lines upright, arrow up.
  // rotation 1 = lines rotated 90, arrow still up. rotation 2 = lines
  // rotated 180, arrow flips to down. rotation 3 = lines rotated 270,
  // arrow stays down.
  function drawStairsIcon(ctx, rect, rotation, alpha, colors) {
    const primaryColor = (colors && colors.primary) || WALL_COLOR;
    const secondaryColor = (colors && colors.secondary) || DEFAULT_SECONDARY_COLOR;
    const { x, y, size } = rect;
    const cx = x + size / 2, cy = y + size / 2;
    const arrowDown = rotation >= 2;

    ctx.save();
    ctx.globalAlpha = alpha;

    // The 6 lines - plain ink strokes, no backing of any kind, so
    // whatever's underneath (a texture, the grid) stays visible
    // around and between them.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((rotation % 4) * (Math.PI / 2));
    ctx.translate(-size / 2, -size / 2);
    const margin = size * 0.1;
    const usableW = size - margin * 2;
    const usableH = size - margin * 2;
    const lineCount = 6;
    const spacing = usableW / lineCount;
    const baseline = size - margin;
    ctx.strokeStyle = primaryColor;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, size * 0.035);
    for (let i = 0; i < lineCount; i++) {
      const lx = margin + spacing * (i + 0.5);
      const lineH = usableH * ((i + 1) / lineCount); // linear step; i === lineCount-1 gives exactly usableH, touching both margins
      ctx.beginPath();
      ctx.moveTo(lx, baseline);
      ctx.lineTo(lx, baseline - lineH);
      ctx.stroke();
    }
    ctx.restore();

    // The arrow - a solid outlined shape rather than a bare stroked
    // line, so it has an actual interior to back. That interior gets
    // filled with the map's own background color first, then
    // outlined in ink - the only part of a stairs icon that blocks
    // what's behind it (the lines it crosses, any texture). Always
    // upright - only its direction, never its own rotation, depends
    // on the structure's rotation (see this function's header comment
    // for why).
    const shaftHalfW = size * 0.063; // was 0.055 - widened ~15%
    const headHalfW = size * 0.138; // was 0.12 - widened ~15%
    const headLen = size * 0.187; // was 0.22 - shortened ~15%
    const arrowTop = y + size * 0.18; // was 0.12 - overall span shortened ~15%, kept centered
    const arrowBottom = y + size * 0.82; // was 0.88
    ctx.beginPath();
    if (!arrowDown) {
      ctx.moveTo(cx, arrowTop);
      ctx.lineTo(cx + headHalfW, arrowTop + headLen);
      ctx.lineTo(cx + shaftHalfW, arrowTop + headLen);
      ctx.lineTo(cx + shaftHalfW, arrowBottom);
      ctx.lineTo(cx - shaftHalfW, arrowBottom);
      ctx.lineTo(cx - shaftHalfW, arrowTop + headLen);
      ctx.lineTo(cx - headHalfW, arrowTop + headLen);
    } else {
      ctx.moveTo(cx, arrowBottom);
      ctx.lineTo(cx + headHalfW, arrowBottom - headLen);
      ctx.lineTo(cx + shaftHalfW, arrowBottom - headLen);
      ctx.lineTo(cx + shaftHalfW, arrowTop);
      ctx.lineTo(cx - shaftHalfW, arrowTop);
      ctx.lineTo(cx - shaftHalfW, arrowBottom - headLen);
      ctx.lineTo(cx - headHalfW, arrowBottom - headLen);
    }
    ctx.closePath();
    ctx.fillStyle = secondaryColor; // backing - masks lines/texture behind the arrow's own footprint only
    ctx.fill();
    ctx.strokeStyle = primaryColor;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, size * 0.03);
    ctx.stroke();

    ctx.restore();
  }

  // The user's own artwork (Chest.svg) - a body rect, a smaller latch
  // rect protruding past its bottom edge, and 4 decorative strap
  // lines near each end. The SVG exported the rects with a
  // transform="rotate(90 ...)" around their own corner (an artifact
  // of whatever tool drew it) - rotating a rect 90 degrees around its
  // own corner just swaps its width/height and repositions it, so
  // these are reproduced directly as the equivalent plain axis-
  // aligned rects rather than replaying the rotation. Z-order (body,
  // then latch, then straps on top) matches the source file.
  function drawChestIcon(ctx, rect, rotation, alpha, colors) {
    const primaryColor = (colors && colors.primary) || WALL_COLOR;
    const secondaryColor = (colors && colors.secondary) || DEFAULT_SECONDARY_COLOR;
    const { x, y, size } = rect;
    const cx = x + size / 2, cy = y + size / 2;
    const nativeW = 148, nativeH = 103;
    const scale = (size / Math.max(nativeW, nativeH)) * 0.9025; // another 5% smaller on top of the previous 5% cut (0.95*0.95), per follow-up feedback it still read too large

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate((rotation % 4) * (Math.PI / 2));
    ctx.translate(-size / 2, -size / 2);
    ctx.translate((size - nativeW * scale) / 2, (size - nativeH * scale) / 2);
    ctx.scale(scale, scale);

    ctx.fillStyle = secondaryColor;
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 5; // matches the lever's native-space stroke weight (0.035 * ~148) - was 2, read as too thin on the map
    ctx.fillRect(0.5, 0.5, 147, 95);
    ctx.strokeRect(0.5, 0.5, 147, 95);
    ctx.fillRect(56.5, 88.5, 35, 14);
    ctx.strokeRect(56.5, 88.5, 35, 14);

    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 3.5; // a notch thinner than the main outline - still a clear increase from the old 1.5, keeps the straps reading as an accent rather than as heavy as the body outline
    ctx.beginPath();
    ctx.moveTo(17.5, 1); ctx.lineTo(17.5, 95);
    ctx.moveTo(33.5, 1); ctx.lineTo(33.5, 95);
    ctx.moveTo(114.5, 2); ctx.lineTo(114.5, 96);
    ctx.moveTo(130.5, 1); ctx.lineTo(130.5, 95);
    ctx.stroke();

    ctx.restore();
  }

  // The user's own artwork (Sack.svg) - a large rounded body plus two
  // small fold/wrinkle details and a wrapped tie-band across the
  // neck, all copied directly via Path2D from the source file's own
  // path data. Native canvas isn't square (140x164), so this fits by
  // the larger dimension (height) and centers the result horizontally
  // within the cell, same approach as the lever. Z-order (body, left
  // fold, right fold, tie band on top) matches the source file.
  function drawItemIcon(ctx, rect, rotation, alpha, colors) {
    const primaryColor = (colors && colors.primary) || WALL_COLOR;
    const secondaryColor = (colors && colors.secondary) || DEFAULT_SECONDARY_COLOR;
    const { x, y, size } = rect;
    const cx = x + size / 2, cy = y + size / 2;
    const nativeW = 140, nativeH = 164;
    const scale = (size / Math.max(nativeW, nativeH)) * 0.95; // 5% smaller than a full fit, per feedback that it read too large on the map

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate((rotation % 4) * (Math.PI / 2));
    ctx.translate(-size / 2, -size / 2);
    ctx.translate((size - nativeW * scale) / 2, (size - nativeH * scale) / 2);
    ctx.scale(scale, scale);

    ctx.fillStyle = secondaryColor;
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 5; // matches the lever/chest's native-space stroke weight - was 3, read as too thin on the map

    const body = new Path2D('M70.2617 29.5904C70.6544 29.7461 71.2335 29.9819 71.9766 30.2984C73.4631 30.9316 75.6053 31.8899 78.2197 33.189C83.4492 35.7876 90.5665 39.7472 98.1152 45.189C113.22 56.0778 130.009 72.8701 136.905 96.5308C140.352 108.356 140.189 118.424 137.457 126.874C134.725 135.324 129.412 142.195 122.498 147.605C108.656 158.437 88.4219 163.391 69.8398 163.391C51.2586 163.391 31.3028 158.437 17.5996 147.606C10.7549 142.196 5.47473 135.325 2.69043 126.872C-0.0937728 118.418 -0.393679 108.348 2.77734 96.521C9.11921 72.8688 25.9023 56.0799 41.1455 45.1909C48.7631 39.7494 55.9846 35.7897 61.3008 33.1909C63.9585 31.8918 66.1396 30.9326 67.6543 30.2993C68.4112 29.9829 69.0018 29.7481 69.4023 29.5923C69.5899 29.5194 69.7361 29.4636 69.8379 29.4253C69.9375 29.4636 70.0797 29.5182 70.2617 29.5904Z');
    ctx.fill(body); ctx.stroke(body);

    const foldL = new Path2D('M68.621 31.5704C67.7353 32.6386 66.2082 33.1823 64.2157 33.2713C62.2341 33.3598 59.8824 32.9929 57.4769 32.3397C52.6572 31.0308 47.7589 28.6143 45.3768 26.6394C40.6831 22.7477 40.033 15.7878 43.9246 11.0941C47.8162 6.40038 54.7762 5.75017 59.4699 9.64183C61.8519 11.6169 65.1339 15.9828 67.3128 20.4767C68.4002 22.7194 69.1969 24.9619 69.4771 26.9256C69.7587 28.9002 69.5067 30.5022 68.621 31.5704Z');
    ctx.fill(foldL); ctx.stroke(foldL);

    const foldR = new Path2D('M67.0669 32.4284C65.8847 30.9855 65.5734 28.8501 65.9572 26.2678C66.3394 23.6964 67.3992 20.7724 68.8335 17.8579C71.7062 12.0204 76.0173 6.35061 79.15 3.78409C85.3446 -1.29102 94.4806 -0.383476 99.5557 5.81115C104.631 12.0058 103.723 21.1417 97.5286 26.2168C94.3959 28.7833 87.9888 31.8947 81.7003 33.5629C78.5605 34.3957 75.4851 34.8596 72.8888 34.7284C70.2815 34.5967 68.2491 33.8714 67.0669 32.4284Z');
    ctx.fill(foldR); ctx.stroke(foldR);

    const tie = new Path2D('M56.0118 31.3911H85.3361C85.4395 31.3913 85.5648 31.4353 85.7159 31.5874C85.872 31.7445 86.0304 31.994 86.173 32.3345C86.4573 33.0139 86.6365 33.9504 86.6691 34.9077C86.7017 35.8679 86.5842 36.7937 86.3214 37.4576C86.0542 38.1322 85.7082 38.3909 85.3361 38.3911H56.0118C55.6397 38.3909 55.2937 38.1322 55.0265 37.4576C54.7637 36.7937 54.6462 35.8679 54.6788 34.9077C54.7114 33.9504 54.8906 33.0139 55.1749 32.3345C55.3175 31.994 55.4759 31.7445 55.632 31.5874C55.7831 31.4353 55.9084 31.3913 56.0118 31.3911Z');
    ctx.fill(tie); ctx.stroke(tie);

    ctx.restore();
  }

  // The user's own artwork (LeverNiceVector.svg) reconstructed with
  // canvas primitives instead of the placeholder stick-and-knob
  // version this used to be - Path2D takes the bracket shape's "d"
  // attribute directly, so that piece is copied verbatim from the
  // SVG rather than re-derived. Native coordinate space is the SVG's
  // own (148x143, roughly square) - scaled down to fit the cell,
  // same as everything else here fits itself to `size`. Z-order
  // (arm, then bracket, then pivot circle, then base plate on top)
  // matches the original file's own paint order.
  function drawLeverIcon(ctx, rect, rotation, alpha, colors, isOn) {
    const primaryColor = (colors && colors.primary) || WALL_COLOR;
    const secondaryColor = (colors && colors.secondary) || DEFAULT_SECONDARY_COLOR;
    const { x, y, size } = rect;
    const cx = x + size / 2, cy = y + size / 2;
    const nativeSize = 148;
    const scale = size / nativeSize;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate((rotation % 4) * (Math.PI / 2));
    ctx.translate(-size / 2, -size / 2);
    ctx.scale(scale, scale);
    ctx.lineWidth = 5; // native-space stroke weight - ends up proportioned like the SVG's own default (thin relative to its 148-unit canvas) once scaled down

    // Arm - a rotated rect, same as the SVG's <rect transform="rotate(...)">.
    // Its fill was mistakenly hardcoded to a fixed grey when this was
    // first ported from the source SVG - it should follow the
    // secondary override the same as the bracket/circle/base plate.
    //
    // The rect's rotation origin (73.6112, 119.021) isn't quite the
    // same point as the pivot circle's own center (74.5, 119.635) -
    // close, but off by (-0.89, -0.61). Mirroring "on" by just negating
    // the rotate() angle (or reflecting it as 180-angle) rotates the
    // arm's *direction* correctly but leaves that start point exactly
    // where it was - so the mirrored arm ends up based at the same
    // slightly-off-center point instead of the true opposite side,
    // which reads as the arm flipping underneath/behind the pivot
    // rather than swinging cleanly to the other end. The actual fix:
    // translate to the REAL pivot first, mirror the whole coordinate
    // system with scale(-1,1) when on (this flips the start-point
    // offset and the rotation direction together, correctly), then
    // re-apply that start-point offset and the ORIGINAL fixed angle -
    // never change the angle itself, only whether the space it's drawn
    // in is mirrored. This happens in the arm's own LOCAL space, before
    // the per-instance `rotation` above carries the whole assembly to
    // wherever it's actually facing - so from the player's view it
    // reads as a horizontal flip or a vertical one depending on that
    // rotation, without this function needing to special-case which.
    const PIVOT_X = 74.5, PIVOT_Y = 119.635;
    const ARM_START_X = 73.6112, ARM_START_Y = 119.021;
    const ARM_ANGLE_DEG = -150;
    ctx.save();
    ctx.translate(PIVOT_X, PIVOT_Y);
    if (isOn) ctx.scale(-1, 1);
    ctx.translate(ARM_START_X - PIVOT_X, ARM_START_Y - PIVOT_Y);
    ctx.rotate((ARM_ANGLE_DEG * Math.PI) / 180);
    ctx.fillStyle = secondaryColor;
    ctx.strokeStyle = primaryColor;
    ctx.fillRect(0, 0, 8, 132.026);
    ctx.strokeRect(0, 0, 8, 132.026);
    ctx.restore();

    // Bracket - copied directly from the SVG's own path data
    const bracket = new Path2D('M74.5 91.6347C89.964 91.6347 102.5 104.171 102.5 119.635C102.5 120.07 102.486 120.503 102.466 120.933H47.3252C47.0563 120.933 46.7919 120.955 46.5332 120.992C46.5114 120.542 46.5 120.09 46.5 119.635C46.5 104.171 59.036 91.6347 74.5 91.6347Z');
    ctx.fillStyle = secondaryColor;
    ctx.strokeStyle = primaryColor;
    ctx.fill(bracket);
    ctx.stroke(bracket);

    // Pivot circle
    ctx.beginPath();
    ctx.arc(74.5, 119.635, 19, 0, Math.PI * 2);
    ctx.fillStyle = secondaryColor;
    ctx.fill();
    ctx.stroke();

    // Base plate - drawn last/on top, same as the source file
    ctx.fillStyle = secondaryColor;
    ctx.fillRect(0.5, 120.635, 147, 21);
    ctx.strokeRect(0.5, 120.635, 147, 21);

    ctx.restore();
  }

  // A door: drawn as a normal wall line spanning the edge when closed
  // (the leaf sits centered on that line); open, the doorway itself
  // goes blank (no line at all - it's a walkable gap now, not a wall)
  // and only the leaf shows, swung to stand perpendicular to the wall.
  // The leaf is a thicker rectangle inset about a tenth of the way in
  // from each end, backed (opaque interior) the same way chest's body
  // or the lever's base plate are. Open, it pivots around its hinge
  // (picked by `rotation`, same 0/1 -> first vertex / 2/3 -> second
  // vertex convention the ghost preview's arc already used) - computed
  // from the edge's own direction rather than hardcoded, so this works
  // identically for horizontal and vertical doors alike (this used to
  // live on a fixed horizontal cell-midline back when doors were
  // cell-based - see the door rework that moved them onto real edges).
  function drawDoorIcon(ctx, x1, y1, x2, y2, cell, rotation, alpha, isGhost, colors, isOpen) {
    const primaryColor = (colors && colors.primary) || WALL_COLOR;
    const secondaryColor = (colors && colors.secondary) || DEFAULT_SECONDARY_COLOR;
    ctx.save();
    ctx.globalAlpha = alpha;

    if (!isOpen) {
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = Math.max(2, cell * 0.08);
      ctx.lineCap = 'square';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len; // unit vector along the edge

    const insetFrac = 0.1;
    const halfLeafLen = (len * (1 - insetFrac * 2)) / 2;
    const halfThick = (cell * 0.22) / 2;

    // Hinge/swing setup - shared between the open leaf's own position
    // below and the ghost arc preview further down, so they always
    // agree on which way a given rotation actually swings.
    const hingeAtStart = rotation === 0 || rotation === 1;
    const hingeX = hingeAtStart ? x1 : x2;
    const hingeY = hingeAtStart ? y1 : y2;
    const closedDirX = hingeAtStart ? ux : -ux;
    const closedDirY = hingeAtStart ? uy : -uy;
    const swingSign = (rotation === 0 || rotation === 2) ? 1 : -1;
    const startAngle = Math.atan2(closedDirY, closedDirX);
    const endAngle = startAngle + swingSign * (Math.PI / 2);

    let leafMidX, leafMidY, dirX, dirY;
    if (isOpen) {
      // Pivots at the hinge rather than sitting centered on the edge -
      // the leaf's own length is unchanged, it just now extends
      // outward from the hinge along the swung (perpendicular)
      // direction instead of along the wall.
      dirX = Math.cos(endAngle);
      dirY = Math.sin(endAngle);
      leafMidX = hingeX + dirX * halfLeafLen;
      leafMidY = hingeY + dirY * halfLeafLen;
    } else {
      dirX = ux;
      dirY = uy;
      leafMidX = (x1 + x2) / 2;
      leafMidY = (y1 + y2) / 2;
    }
    const px = -dirY, py = dirX; // perpendicular to whichever direction the leaf is actually lying along
    const corners = [
      { x: leafMidX - dirX * halfLeafLen - px * halfThick, y: leafMidY - dirY * halfLeafLen - py * halfThick },
      { x: leafMidX + dirX * halfLeafLen - px * halfThick, y: leafMidY + dirY * halfLeafLen - py * halfThick },
      { x: leafMidX + dirX * halfLeafLen + px * halfThick, y: leafMidY + dirY * halfLeafLen + py * halfThick },
      { x: leafMidX - dirX * halfLeafLen + px * halfThick, y: leafMidY - dirY * halfLeafLen + py * halfThick },
    ];
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = secondaryColor;
    ctx.fill();
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = Math.max(1.2, cell * 0.035);
    ctx.stroke();

    if (isGhost) {
      ctx.strokeStyle = '#8a8a8a';
      ctx.lineWidth = Math.max(1, cell * 0.03);
      ctx.beginPath();
      ctx.arc(hingeX, hingeY, cell, startAngle, endAngle, swingSign < 0);
      ctx.stroke();
    }

    ctx.restore();
  }

  // Computes an edge's on-screen endpoints - the same small calc
  // drawWallSegment does inline, factored out so the doors loop/ghost/
  // delete-highlight in renderOverlay can share it instead of
  // repeating it three times.
  function edgePixels(edge, view) {
    const cell = view.cellSize * view.zoom;
    if (edge.type === 'h') {
      return { x1: view.offsetX + edge.col * cell, y1: view.offsetY + edge.row * cell, x2: view.offsetX + (edge.col + 1) * cell, y2: view.offsetY + edge.row * cell, cell };
    }
    return { x1: view.offsetX + edge.col * cell, y1: view.offsetY + edge.row * cell, x2: view.offsetX + edge.col * cell, y2: view.offsetY + (edge.row + 1) * cell, cell };
  }

  // A wire endpoint's own screen-space anchor point. Edge-keyed items
  // (walls, doors) always anchor on the edge's plain midpoint - the
  // per-category vertical offset below only applies to cell-keyed
  // items, and "does not apply to doors" falls out of that for free
  // since doors are edge-keyed, never reaching the cell branch at all.
  // For a cell, the anchor's height depends on the CATEGORY actually
  // being wired (not just the key) - two wires into the same cell, one
  // to its texture and one to its structure, need different points or
  // they'd sit exactly on top of each other and read as one wire.
  // Structure: lower third. Texture: upper third. Logic (and anything
  // without a specific rule, e.g. an as-yet-unpicked pending
  // destination): center.
  function itemScreenCenter(key, category, view) {
    if (key.indexOf(':') !== -1) {
      const p = edgePixels(parseWallKey(key), view);
      return { x: (p.x1 + p.x2) / 2, y: (p.y1 + p.y2) / 2 };
    }
    const [col, row] = key.split(',').map(Number);
    const r = cellRect(col, row, view);
    const x = r.x + r.size / 2;
    let y;
    if (category === 'texture') y = r.y + r.size / 6;
    else if (category === 'structure') y = r.y + (r.size * 5) / 6;
    else y = r.y + r.size / 2;
    return { x, y };
  }

  function drawStructure(ctx, rect, type, rotation, view, alpha, colors, isOn) {
    if (type.id === 'stairs') drawStairsIcon(ctx, rect, rotation, alpha, colors);
    else if (type.id === 'chest') drawChestIcon(ctx, rect, rotation, alpha, colors);
    else if (type.id === 'item') drawItemIcon(ctx, rect, rotation, alpha, colors);
    else if (type.id === 'lever') drawLeverIcon(ctx, rect, rotation, alpha, colors, isOn);
  }


  // a translucent ghost of whatever's selected under the cursor while
  // Place is active, and a red highlight over whatever's under the
  // cursor while Delete is active - every frame.
  // ---------------------------------------------------------------
  function renderOverlay(ctx, view) {
    for (const [key, typeId] of walls) {
      const type = findType('wall', typeId);
      if (!type) continue; // a saved wall of a type that's since been removed - skip rather than throw
      const paint = wallColors.get(key);
      drawWallSegment(ctx, parseWallKey(key), type, view, 1, paint && paint.primary);
    }
    for (const [key, typeId] of textures) {
      const type = findType('texture', typeId);
      if (!type) continue;
      const [col, row] = key.split(',').map(Number);
      const paint = textureColors.get(key);
      drawTexture(ctx, cellRect(col, row, view), type, textureRotations.get(key) || 0, view, 1, paint && paint.primary, paint && paint.secondary);
    }
    // Doors are a structure type (selected from Structures, share
    // structureRotation/the R hotkey/etc.) and should sit above
    // textures the same as every other structure does - drawing them
    // right after walls (before textures) was a leftover from before
    // textures existed and left doors rendering underneath texture
    // fills, the one structure that didn't visually sit on top.
    for (const [key, rotation] of doors) {
      const { x1, y1, x2, y2, cell } = edgePixels(parseWallKey(key), view);
      const paint = structureColors.get(key);
      const isOpen = !!doorOpenStates.get(key);
      drawDoorIcon(ctx, x1, y1, x2, y2, cell, rotation, 1, false, paint, isOpen);
    }
    for (const [key, typeId] of structures) {
      const type = findType('structure', typeId);
      if (!type) continue;
      const [col, row] = key.split(',').map(Number);
      const rotation = structureRotations.get(key) || 0;
      const paint = structureColors.get(key);
      const isOn = leverOnStates.get(key) || false;
      drawStructure(ctx, cellRect(col, row, view), type, rotation, view, 1, paint, isOn);
    }

    // Logic - drawn last of the four placed-content layers so it
    // always sits on top of walls/textures/structures/doors, per spec.
    // An edge key (has a ':', see parseWallKey) draws centered on that
    // edge's midpoint; anything else is a plain cell key and draws
    // centered in that tile. Deliberately smaller than a full cell
    // (0.55x) - it's an overlay marker, not floor/wall content that
    // should fill the cell the way textures/structures do.
    for (const [key, typeId] of logic) {
      const isEdge = key.indexOf(':') !== -1;
      if (isEdge) {
        const { x1, y1, x2, y2, cell } = edgePixels(parseWallKey(key), view);
        drawLogicIcon(ctx, (x1 + x2) / 2, (y1 + y2) / 2, cell * 0.55, typeId);
      } else {
        const [col, row] = key.split(',').map(Number);
        const r = cellRect(col, row, view);
        drawLogicIcon(ctx, r.x + r.size / 2, r.y + r.size / 2, r.size * 0.55, typeId);
      }
    }

    // Configure's current selection - a blue highlight rather than
    // Delete's red, so the two don't read as "this is about to be
    // removed". Persistent (tied to configureTarget, not hover) since
    // it's showing what the sidebar list is currently describing, not
    // previewing a pending action. Suppressed entirely while a color
    // picker is open in the panel - an item actively being recolored
    // shouldn't also be sitting under a highlight tint that would
    // throw off how its new color actually reads.
    //
    // While a wire is being built, BOTH the source's location
    // (configureTarget, which stays put the whole time) and whatever
    // destination location has been clicked so far
    // (pendingWireDestTarget) get this same highlight, per spec -
    // "highlight both locations until the wire has been created".
    function drawConfigureHighlight(target) {
      ctx.save();
      ctx.fillStyle = '#2f6fb0';
      ctx.strokeStyle = '#2f6fb0';
      if (target.edge) {
        // Edge wins over the tile it borders - only one of the two
        // highlights is ever drawn per target, matching the single-
        // target selection in renderConfigurePanel/renderWirePanel.
        const { x1, y1, x2, y2, cell } = edgePixels(target.edge, view);
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = cell * 0.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      } else {
        const r = cellRect(target.col, target.row, view);
        ctx.globalAlpha = 0.25;
        ctx.fillRect(r.x, r.y, r.size, r.size);
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x, r.y, r.size, r.size);
      }
      ctx.restore();
    }
    // Suppressed entirely while a color picker is open in the panel -
    // an item actively being recolored shouldn't also be sitting under
    // a highlight tint that would throw off how its new color reads.
    if (activeTool === 'configure' && configureTarget && !configureColorPickerOpen) {
      drawConfigureHighlight(configureTarget);
      if (configureMode === 'wire' && pendingWireDestTarget) {
        drawConfigureHighlight(pendingWireDestTarget);
      }
    }

    // Select tool's Arrange mode - while an item is actively being
    // dragged, highlight both where it started (dimmer, since it's
    // being vacated) and wherever it would land if dropped right now
    // (brighter) - green rather than Configure's blue or Delete's red,
    // reading as "this is where the move would go" instead of either
    // of those. Skips the destination side entirely when the current
    // cursor position isn't actually a valid drop for this item's
    // category (an edge-bound thing hovering dead center of a cell,
    // say) - matches moveItem's own commit logic exactly, so the
    // preview never promises a drop that wouldn't actually happen.
    if (activeTool === 'select' && selectMode === 'arrange' && arrangeDragItem && arrangeDragCurrentInfo) {
      const drawArrangeHighlight = (target, alpha) => {
        ctx.save();
        ctx.fillStyle = '#3a9e5c';
        ctx.strokeStyle = '#3a9e5c';
        if (target.edge) {
          const { x1, y1, x2, y2, cell } = edgePixels(target.edge, view);
          ctx.globalAlpha = alpha;
          ctx.lineWidth = cell * 0.3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        } else {
          const r = cellRect(target.col, target.row, view);
          ctx.globalAlpha = alpha * 0.35;
          ctx.fillRect(r.x, r.y, r.size, r.size);
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 2;
          ctx.strokeRect(r.x, r.y, r.size, r.size);
        }
        ctx.restore();
      };
      drawArrangeHighlight(targetFromKey(arrangeDragItem.key), 0.35); // origin - dimmer, being vacated

      // Only wall/door are actually edge-ONLY (moveItem/handleArrangeGesture's
      // commit bails out with no valid target at all if there's no edge
      // under the drop point for those). Logic is edge-OR-cell - it
      // takes whichever the drop point resolves to, same as its own
      // commit logic above - so lumping it in with wall/door here was
      // the bug: it forced dropIsValid to require an edge for Logic
      // too, so a Logic piece being dragged toward a plain cell (not a
      // line) never showed a destination highlight at all.
      const requiresEdge = arrangeDragItem.category === 'wall' || arrangeDragItem.typeId === 'door';
      const dropIsValid = !requiresEdge || !!arrangeDragCurrentInfo.edge;
      if (dropIsValid) {
        const dropTarget = (requiresEdge || (arrangeDragItem.category === 'logic' && arrangeDragCurrentInfo.edge))
          ? { edge: arrangeDragCurrentInfo.edge }
          : { col: arrangeDragCurrentInfo.col, row: arrangeDragCurrentInfo.row };
        drawArrangeHighlight(dropTarget, 0.75);
      }
    }

    // Wires - only ever visible in Configure's own Wire mode, never in
    // Edit mode and never once Play mode exists, so they can't jumble
    // the screen for anyone not actively building the logic (see the
    // person's own reasoning for this). Deliberately simple: a single
    // straight line between each wire's two endpoint centers, thinner
    // than the Configure highlight above and drawn after it so a wire
    // touching the currently-selected item still reads as a distinct,
    // thin line layered on top rather than getting lost in the tint.
    // Later wires draw after earlier ones by nothing more than array
    // order (new wires are always pushed to the end) - "on a layer
    // above other wires" falls out of that for free.
    if (activeTool === 'configure' && configureMode === 'wire' && wires.length > 0) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, view.cellSize * view.zoom * 0.035);
      for (const w of wires) {
        const from = itemScreenCenter(w.fromKey, w.fromCategory, view);
        const to = itemScreenCenter(w.toKey, w.toCategory, view);
        ctx.strokeStyle = w.color || DEFAULT_PRIMARY_COLOR;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // The wire currently being built - follows the cursor until a
    // destination location has actually been clicked, at which point
    // it snaps to that location's center instead (matching the
    // highlight box there) rather than continuing to track the mouse.
    // Per spec: "the wire begins drawing from their cursor and can be
    // dragged to any space". Same thin/solid look as a committed wire,
    // just still following the pointer - there's no dashed/ghost
    // styling distinction called for here. The destination end stays
    // dead-center here rather than using the category-based offset
    // (unlike a committed wire's `to`) since no specific item has been
    // picked for it yet at this point - only a location has. Drawn in
    // wireDrawColor - the color a NEW wire will actually get - so
    // adjusting it via the header's own color row gives immediate
    // feedback on the wire actually being built.
    if (activeTool === 'configure' && configureMode === 'wire' && pendingWireSource) {
      const from = itemScreenCenter(pendingWireSource.key, pendingWireSource.category, view);
      let to = null;
      if (pendingWireDestTarget) {
        to = pendingWireDestTarget.edge
          ? itemScreenCenter(wallKey(pendingWireDestTarget.edge), null, view)
          : itemScreenCenter(cellKey(pendingWireDestTarget.col, pendingWireDestTarget.row), null, view);
      } else if (view.hover) {
        to = { x: view.offsetX + view.hover.worldX * view.zoom, y: view.offsetY + view.hover.worldY * view.zoom };
      }
      if (to) {
        ctx.save();
        ctx.strokeStyle = wireDrawColor;
        ctx.globalAlpha = 0.85;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1, view.cellSize * view.zoom * 0.035);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Line mode's traced-but-uncommitted path - independent of hover,
    // driven by its own tracked state, so it stays visible even if
    // the cursor's raw position briefly reports no hover mid-drag.
    if (linePreviewEdges.length && lineWallTypeId) {
      const type = findType('wall', lineWallTypeId);
      if (type) {
        for (const edge of linePreviewEdges) drawWallSegment(ctx, edge, type, view, 0.35);
      }
    }

    // Selection rectangle - same independence from hover.
    if (selectionRect) {
      const sx1 = view.offsetX + Math.min(selectionRect.x1, selectionRect.x2) * view.zoom;
      const sy1 = view.offsetY + Math.min(selectionRect.y1, selectionRect.y2) * view.zoom;
      const sx2 = view.offsetX + Math.max(selectionRect.x1, selectionRect.x2) * view.zoom;
      const sy2 = view.offsetY + Math.max(selectionRect.y1, selectionRect.y2) * view.zoom;
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = '#c0392b';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx1, sy1, sx2 - sx1, sy2 - sy1);
      ctx.restore();
    }

    if (!view.hover) return;

    if (activeTool === 'place' && selected && !linePreviewEdges.length) {
      if (selected.category === 'wall') {
        if (view.hover.edge) {
          const type = findType('wall', selected.id);
          if (type) drawWallSegment(ctx, view.hover.edge, type, view, 0.35);
        }
      } else if (selected.category === 'texture') {
        const type = findType('texture', selected.id);
        if (type) drawTexture(ctx, cellRect(view.hover.col, view.hover.row, view), type, placeRotation, view, 0.35);
      } else if (selected.category === 'structure') {
        if (selected.id === 'door') {
          // Doors preview on the hovered edge, same as a wall would -
          // not centered in the hovered cell like every other
          // structure.
          if (view.hover.edge) {
            const { x1, y1, x2, y2, cell } = edgePixels(view.hover.edge, view);
            drawDoorIcon(ctx, x1, y1, x2, y2, cell, placeRotation, 0.35, true);
          }
        } else {
          const type = findType('structure', selected.id);
          if (type) drawStructure(ctx, cellRect(view.hover.col, view.hover.row, view), type, placeRotation, view, 0.35);
        }
      } else if (selected.category === 'logic') {
        // Same edge-wins-when-close-enough targeting as the actual
        // placement (handleMapClick) - preview on whichever one this
        // hover would actually commit to.
        let refSize, gx, gy;
        if (view.hover.edge) {
          const p = edgePixels(view.hover.edge, view);
          refSize = p.cell;
          gx = (p.x1 + p.x2) / 2;
          gy = (p.y1 + p.y2) / 2;
        } else {
          const r = cellRect(view.hover.col, view.hover.row, view);
          refSize = r.size;
          gx = r.x + r.size / 2;
          gy = r.y + r.size / 2;
        }
        drawLogicIcon(ctx, gx, gy, refSize * 0.55, selected.id, 0.35);
      }
    } else if (activeTool === 'delete' && !selectionRect) {
      const wKey = view.hover.edge ? wallKey(view.hover.edge) : null;
      // Logic takes priority over whatever it's sitting on top of -
      // same edge-then-cell, logic-first order handleMapClick's own
      // delete branch uses, since Logic renders on top of everything
      // else and a click/hover there most likely targets the logic
      // piece itself. Missing entirely before - Delete's hover only
      // ever highlighted walls/doors/textures/structures, so a Logic
      // piece gave no feedback at all that it was about to be deleted.
      if (wKey && logic.has(wKey)) {
        const { x1, y1, x2, y2, cell } = edgePixels(view.hover.edge, view);
        const gx = (x1 + x2) / 2, gy = (y1 + y2) / 2;
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.arc(gx, gy, cell * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        drawLogicIcon(ctx, gx, gy, cell * 0.55, logic.get(wKey), 1);
        return;
      }
      if (wKey && doors.has(wKey)) {
        const { x1, y1, x2, y2, cell } = edgePixels(view.hover.edge, view);
        drawDoorIcon(ctx, x1, y1, x2, y2, cell, doors.get(wKey), 1, false, null, !!doorOpenStates.get(wKey));
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#c0392b';
        ctx.lineWidth = cell * 0.3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
        return;
      }
      const existingWallType = wKey && walls.has(wKey) && findType('wall', walls.get(wKey));
      if (existingWallType) {
        drawWallSegment(ctx, view.hover.edge, existingWallType, view, 0.6, '#c0392b');
        return;
      }
      const cKey = cellKey(view.hover.col, view.hover.row);
      if (logic.has(cKey)) {
        const rect = cellRect(view.hover.col, view.hover.row, view);
        const gx = rect.x + rect.size / 2, gy = rect.y + rect.size / 2;
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.arc(gx, gy, rect.size * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        drawLogicIcon(ctx, gx, gy, rect.size * 0.55, logic.get(cKey), 1);
        return;
      }
      const existingCellTypeId = structures.get(cKey) || textures.get(cKey);
      if (existingCellTypeId) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#c0392b';
        const rect = cellRect(view.hover.col, view.hover.row, view);
        ctx.fillRect(rect.x, rect.y, rect.size, rect.size);
        ctx.restore();
      }
    }
  }

  // ---------------------------------------------------------------
  // Sidebar swatch previews (SVG - crisp at any size, and simplest
  // way to preview a pattern without spinning up a canvas per button)
  // ---------------------------------------------------------------
  function wallSwatchSvg(type) {
    const w = 50, h = 30, y = h / 2;
    if (type.pattern === 'straight') {
      const dashAttr = type.dash && type.dash.length ? ` stroke-dasharray="${type.dash.join(',')}"` : '';
      const cap = type.id === 'dotted' ? 'round' : 'square';
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><line x1="4" y1="${y}" x2="${w - 4}" y2="${y}" stroke="${WALL_COLOR}" stroke-width="2.5" stroke-linecap="${cap}"${dashAttr}/></svg>`;
    }
    const points = buildWaveringPoints(4, y, w - 4, y, 12, 5, type.pattern === 'wavy');
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" stroke="${WALL_COLOR}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function textureSwatchSvg(type) {
    const w = 50, h = 30;
    const uid = 'texpat-' + type.id;
    if (type.pattern === 'solid') {
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${type.color}"/></svg>`;
    }
    if (type.pattern === 'diagonal') {
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <defs><pattern id="${uid}" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="7" stroke="${type.color}" stroke-width="2.5"/>
        </pattern></defs>
        <rect width="${w}" height="${h}" fill="url(#${uid})"/>
      </svg>`;
    }
    if (type.pattern === 'dotted') {
      // The diagonal texture's exact same repeating band, just
      // dashed into round dots instead of a solid stroke - "the
      // striped texture but made of dots instead of lines."
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <defs><pattern id="${uid}" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="7" stroke="${type.color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="0.1,3"/>
        </pattern></defs>
        <rect width="${w}" height="${h}" fill="url(#${uid})"/>
      </svg>`;
    }
    if (type.pattern === 'wavy') {
      // Explicit wavy diagonal strokes drawn directly (rather than an
      // SVG pattern tile - a wavering path doesn't repeat as cleanly
      // in a small tile as a straight line does), clipped to the
      // button's box. Same fixes as the map version: fewer/wider-
      // spaced lines, more steps for a smoother curve, and a locked
      // whole number of periods so each line's wobble is exactly 0 at
      // both ends instead of cutting off short of the button's edge.
      const paths = [];
      const diag = Math.max(w, h) + 20;
      const periods = 3; // more than the map's 2 since this preview is a much shorter span
      for (let o = -diag; o < diag; o += 12) {
        const steps = 16;
        let d = '';
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const baseX = o + t * diag;
          const baseY = t * diag;
          const wobble = Math.sin(t * periods * Math.PI * 2) * 2.2;
          const px = baseX + wobble * 0.7071;
          const py = baseY - wobble * 0.7071;
          d += (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1) + ' ';
        }
        paths.push(`<path d="${d}" stroke="${type.color}" stroke-width="2" fill="none" stroke-linecap="round"/>`);
      }
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <clipPath id="clip-${uid}"><rect width="${w}" height="${h}"/></clipPath>
        <g clip-path="url(#clip-${uid})">${paths.join('')}</g>
      </svg>`;
    }
    // cracked - a purpose-built compact icon rather than scaling the
    // same CRACK_DEFS used on the map. Those are four separate cracks
    // anchored to a square cell's edges, deliberately staying clear
    // of the center - squeezed into a small rectangular button, that
    // reads as a handful of disconnected scratches in the corners
    // instead of a crack. This is a single continuous jagged line
    // with a couple of branches, sized to actually fill this box.
    return CRACKED_ICON_SVG;
  }

  // Same default-orientation icons as drawStairsIcon/drawChestIcon
  // above, redrawn as static SVG for the sidebar/header swatch preview
  // (see wallSwatchSvg/textureSwatchSvg for the same split - a canvas
  // version for the live map, an SVG version for a crisp small button
  // preview). Rotation isn't shown here; the button always previews a
  // type's default (0) orientation.
  function structureSwatchSvg(type) {
    const w = 50, h = 30;
    if (type.id === 'stairs') {
      const margin = 4;
      const usableW = w - margin * 2;
      const usableH = h - margin * 2;
      const lineCount = 6;
      const spacing = usableW / lineCount;
      const baseline = h - margin;
      let lines = '';
      for (let i = 0; i < lineCount; i++) {
        const lx = margin + spacing * (i + 0.5);
        const lineH = usableH * ((i + 1) / lineCount); // linear step; last one spans usableH exactly
        lines += `<line x1="${lx.toFixed(1)}" y1="${baseline}" x2="${lx.toFixed(1)}" y2="${(baseline - lineH).toFixed(1)}" stroke="${WALL_COLOR}" stroke-width="1.6" stroke-linecap="round"/>`;
      }
      const cx = w / 2;
      const shaftHalfW = 2.07, headHalfW = 4.6, headLen = 5.5; // widened ~15%, shortened ~15%, matching drawStairsIcon
      const arrowTop = 5.65, arrowBottom = 24.35; // span shortened ~15%, kept centered within [margin, h-margin]
      const arrowPath = `M${cx},${arrowTop} `
        + `L${cx + headHalfW},${arrowTop + headLen} L${cx + shaftHalfW},${arrowTop + headLen} L${cx + shaftHalfW},${arrowBottom} `
        + `L${cx - shaftHalfW},${arrowBottom} L${cx - shaftHalfW},${arrowTop + headLen} L${cx - headHalfW},${arrowTop + headLen} Z`;
      // Filled with the map's own background color first (the same
      // "backing" the canvas version gives it - see drawStairsIcon),
      // then outlined in ink, so the arrow is the only part of the
      // icon with an opaque interior.
      const arrow = `<path d="${arrowPath}" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="1.4" stroke-linejoin="round"/>`;
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${lines}${arrow}</svg>`;
    }
    if (type.id === 'chest') {
      // The user's own artwork (Chest.svg), simplified from its
      // rotated-rect export into the equivalent plain rects (see
      // drawChestIcon for why that's a safe simplification). The
      // viewBox is padded beyond the content's own bounding box
      // (rather than the tight 0 0 148 103 it would otherwise need)
      // so the chest sits smaller within its button with a bit of
      // breathing room, instead of filling it edge to edge.
      return `<svg width="${w}" height="${h}" viewBox="-13 -9 174 121">
        <rect x="0.5" y="0.5" width="147" height="95" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <rect x="56.5" y="88.5" width="35" height="14" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <line x1="17.5" y1="1" x2="17.5" y2="95" stroke="${WALL_COLOR}" stroke-width="3.5"/>
        <line x1="33.5" y1="1" x2="33.5" y2="95" stroke="${WALL_COLOR}" stroke-width="3.5"/>
        <line x1="114.5" y1="2" x2="114.5" y2="96" stroke="${WALL_COLOR}" stroke-width="3.5"/>
        <line x1="130.5" y1="1" x2="130.5" y2="95" stroke="${WALL_COLOR}" stroke-width="3.5"/>
      </svg>`;
    }
    if (type.id === 'item') {
      // The user's own artwork (Sack.svg), cropped to 5:3 (140x84 out
      // of its native 140x164) via viewBox rather than squeezed to
      // fit - keeps the tied neck and the upper body, the most
      // recognizable part of the silhouette, and simply clips the
      // lower portion of the sack rather than distorting the whole
      // shape. drawItemIcon on the map uses the full, uncropped
      // artwork - this crop is swatch-only.
      return `<svg width="${w}" height="${h}" viewBox="0 0 140 84">
        <path d="M70.2617 29.5904C70.6544 29.7461 71.2335 29.9819 71.9766 30.2984C73.4631 30.9316 75.6053 31.8899 78.2197 33.189C83.4492 35.7876 90.5665 39.7472 98.1152 45.189C113.22 56.0778 130.009 72.8701 136.905 96.5308C140.352 108.356 140.189 118.424 137.457 126.874C134.725 135.324 129.412 142.195 122.498 147.605C108.656 158.437 88.4219 163.391 69.8398 163.391C51.2586 163.391 31.3028 158.437 17.5996 147.606C10.7549 142.196 5.47473 135.325 2.69043 126.872C-0.0937728 118.418 -0.393679 108.348 2.77734 96.521C9.11921 72.8688 25.9023 56.0799 41.1455 45.1909C48.7631 39.7494 55.9846 35.7897 61.3008 33.1909C63.9585 31.8918 66.1396 30.9326 67.6543 30.2993C68.4112 29.9829 69.0018 29.7481 69.4023 29.5923C69.5899 29.5194 69.7361 29.4636 69.8379 29.4253C69.9375 29.4636 70.0797 29.5182 70.2617 29.5904Z" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <path d="M68.621 31.5704C67.7353 32.6386 66.2082 33.1823 64.2157 33.2713C62.2341 33.3598 59.8824 32.9929 57.4769 32.3397C52.6572 31.0308 47.7589 28.6143 45.3768 26.6394C40.6831 22.7477 40.033 15.7878 43.9246 11.0941C47.8162 6.40038 54.7762 5.75017 59.4699 9.64183C61.8519 11.6169 65.1339 15.9828 67.3128 20.4767C68.4002 22.7194 69.1969 24.9619 69.4771 26.9256C69.7587 28.9002 69.5067 30.5022 68.621 31.5704Z" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <path d="M67.0669 32.4284C65.8847 30.9855 65.5734 28.8501 65.9572 26.2678C66.3394 23.6964 67.3992 20.7724 68.8335 17.8579C71.7062 12.0204 76.0173 6.35061 79.15 3.78409C85.3446 -1.29102 94.4806 -0.383476 99.5557 5.81115C104.631 12.0058 103.723 21.1417 97.5286 26.2168C94.3959 28.7833 87.9888 31.8947 81.7003 33.5629C78.5605 34.3957 75.4851 34.8596 72.8888 34.7284C70.2815 34.5967 68.2491 33.8714 67.0669 32.4284Z" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <path d="M56.0118 31.3911H85.3361C85.4395 31.3913 85.5648 31.4353 85.7159 31.5874C85.872 31.7445 86.0304 31.994 86.173 32.3345C86.4573 33.0139 86.6365 33.9504 86.6691 34.9077C86.7017 35.8679 86.5842 36.7937 86.3214 37.4576C86.0542 38.1322 85.7082 38.3909 85.3361 38.3911H56.0118C55.6397 38.3909 55.2937 38.1322 55.0265 37.4576C54.7637 36.7937 54.6462 35.8679 54.6788 34.9077C54.7114 33.9504 54.8906 33.0139 55.1749 32.3345C55.3175 31.994 55.4759 31.7445 55.632 31.5874C55.7831 31.4353 55.9084 31.3913 56.0118 31.3911Z" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
      </svg>`;
    }
    if (type.id === 'lever') {
      // The user's own artwork (LeverNiceVector.svg), embedded as-is
      // minus its design-tool background rect - already uses our
      // exact ink/backing hex codes. Kept in its native viewBox
      // (148x143, roughly square) rather than force-fit to the
      // button's usual 50x30/5:3 box, so nothing about their design
      // is stretched or cropped - this does mean it letterboxes
      // (empty margin left/right) in the swatch button for now.
      return `<svg width="${w}" height="${h}" viewBox="0 0 148 143">
        <rect x="73.6112" y="119.021" width="8" height="132.026" transform="rotate(-150 73.6112 119.021)" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <path d="M74.5 91.6347C89.964 91.6347 102.5 104.171 102.5 119.635C102.5 120.07 102.486 120.503 102.466 120.933H47.3252C47.0563 120.933 46.7919 120.955 46.5332 120.992C46.5114 120.542 46.5 120.09 46.5 119.635C46.5 104.171 59.036 91.6347 74.5 91.6347Z" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <circle cx="74.5" cy="119.635" r="19" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
        <rect x="0.5" y="120.635" width="147" height="21" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="5"/>
      </svg>`;
    }
    if (type.id === 'door') {
      const cy = h / 2, x1 = 4, x2 = w - 4;
      const insetFrac = 0.1;
      const leafX1 = x1 + (x2 - x1) * insetFrac;
      const leafX2 = x2 - (x2 - x1) * insetFrac;
      const leafThickness = 9;
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" stroke="${WALL_COLOR}" stroke-width="2.5" stroke-linecap="square"/>
        <rect x="${leafX1.toFixed(1)}" y="${(cy - leafThickness / 2).toFixed(1)}" width="${(leafX2 - leafX1).toFixed(1)}" height="${leafThickness}" fill="${DEFAULT_SECONDARY_COLOR}" stroke="${WALL_COLOR}" stroke-width="1.6"/>
      </svg>`;
    }
    return '';
  }

  // Logic swatch previews - plain icons, same as every other
  // category's swatch button (no backing square here - that's an
  // on-map-only treatment, see drawLogicIcon). Just placeholder-
  // simple icons for now, per the person's own spec - "reflective of
  // what it does (or for now, what it will do)".
  const LOGIC_ICON_UNIT = 24; // both this and drawLogicIcon's canvas version use a 24x24 design grid
  function logicSwatchSvg(type) {
    const u = LOGIC_ICON_UNIT;
    if (type.id === 'switch') {
      // Super simplified lever: a horizontal base line, a diagonal
      // line emerging from its middle, a dot at the diagonal's end.
      return `<svg width="${u}" height="${u}" viewBox="0 0 ${u} ${u}">
        <line x1="4" y1="18" x2="20" y2="18" stroke="${WALL_COLOR}" stroke-width="2" stroke-linecap="round"/>
        <line x1="12" y1="18" x2="18" y2="7" stroke="${WALL_COLOR}" stroke-width="2" stroke-linecap="round"/>
        <circle cx="18" cy="7" r="2.2" fill="${WALL_COLOR}"/>
      </svg>`;
    }
    if (type.id === 'break') {
      // A single jagged crack running from the top of the icon to the
      // bottom.
      return `<svg width="${u}" height="${u}" viewBox="0 0 ${u} ${u}">
        <path d="M12,2 L9,7 L14,11 L8,15 L13,19 L10,22" stroke="${WALL_COLOR}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    }
    if (type.id === 'hide') {
      // An eye (two arcs + pupil) with a diagonal slash through it.
      return `<svg width="${u}" height="${u}" viewBox="0 0 ${u} ${u}">
        <path d="M3,12 Q12,4 21,12 Q12,20 3,12 Z" stroke="${WALL_COLOR}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="12" cy="12" r="2.5" fill="${WALL_COLOR}"/>
        <line x1="3" y1="3" x2="21" y2="21" stroke="${WALL_COLOR}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
    }
    if (type.id === 'recolor') {
      // A paintbrush: angled handle, a bold wedge-shaped bristle tip,
      // and a paint dab at the base - sized generously since a subtle
      // wedge disappears at icon scale.
      return `<svg width="${u}" height="${u}" viewBox="0 0 ${u} ${u}">
        <line x1="4" y1="21" x2="13" y2="12" stroke="${WALL_COLOR}" stroke-width="2.4" stroke-linecap="round"/>
        <path d="M11,13 L18,2 L22,5 L14,15 Z" fill="${WALL_COLOR}"/>
        <circle cx="4" cy="21" r="2.8" fill="${WALL_COLOR}"/>
      </svg>`;
    }
    if (type.id === 'move') {
      // Four connected cardinal arrows (the standard "move" glyph).
      return `<svg width="${u}" height="${u}" viewBox="0 0 ${u} ${u}">
        <polyline points="5,9 2,12 5,15" stroke="${WALL_COLOR}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="9,5 12,2 15,5" stroke="${WALL_COLOR}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="15,19 12,22 9,19" stroke="${WALL_COLOR}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="19,9 22,12 19,15" stroke="${WALL_COLOR}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="2" y1="12" x2="22" y2="12" stroke="${WALL_COLOR}" stroke-width="2" stroke-linecap="round"/>
        <line x1="12" y1="2" x2="12" y2="22" stroke="${WALL_COLOR}" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
    }
    return '';
  }

  // Canvas-primitive version of the same two icons for the actual map,
  // drawn centered at (cx, cy). `refSize` is just a scale reference
  // (the caller passes the same cell/edge-derived value it always
  // has) - the icon's own absolute size is refSize * LOGIC_ICON_SCALE
  // (unchanged from before), but the backing square is now sized to
  // snugly hug THAT icon (LOGIC_SQUARE_PADDING over it) rather than
  // being a much larger box the icon sat inside of. The backing is
  // opaque (covers whatever's underneath, same convention as
  // structures). Kept numerically identical to logicSwatchSvg's paths
  // (same LOGIC_ICON_UNIT coordinate grid, just re-expressed as ctx
  // calls) so the map icon and the tray preview never drift apart.
  const LOGIC_ICON_SCALE = 0.5;
  const LOGIC_SQUARE_PADDING = 1.2; // the backed square is only 20% bigger than the icon itself
  function drawLogicIcon(ctx, cx, cy, refSize, typeId, alpha) {
    const a = alpha === undefined ? 1 : alpha;
    const iconSize = refSize * LOGIC_ICON_SCALE;
    const squareSize = iconSize * LOGIC_SQUARE_PADDING;
    const half = squareSize / 2;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = DEFAULT_SECONDARY_COLOR;
    ctx.strokeStyle = WALL_COLOR;
    ctx.lineWidth = Math.max(1, squareSize * 0.06);
    ctx.fillRect(cx - half, cy - half, squareSize, squareSize);
    ctx.strokeRect(cx - half, cy - half, squareSize, squareSize);
    ctx.restore();

    const s = iconSize / LOGIC_ICON_UNIT;
    const ox = cx - iconSize / 2, oy = cy - iconSize / 2;
    const px = (lx) => ox + lx * s;
    const py = (ly) => oy + ly * s;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = WALL_COLOR;
    ctx.fillStyle = WALL_COLOR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, 2 * s);
    if (typeId === 'switch') {
      ctx.beginPath();
      ctx.moveTo(px(4), py(18));
      ctx.lineTo(px(20), py(18));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(12), py(18));
      ctx.lineTo(px(18), py(7));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px(18), py(7), Math.max(1.2, 2.2 * s), 0, Math.PI * 2);
      ctx.fill();
    } else if (typeId === 'break') {
      ctx.beginPath();
      ctx.moveTo(px(12), py(2));
      ctx.lineTo(px(9), py(7));
      ctx.lineTo(px(14), py(11));
      ctx.lineTo(px(8), py(15));
      ctx.lineTo(px(13), py(19));
      ctx.lineTo(px(10), py(22));
      ctx.stroke();
    } else if (typeId === 'hide') {
      ctx.beginPath();
      ctx.moveTo(px(3), py(12));
      ctx.quadraticCurveTo(px(12), py(4), px(21), py(12));
      ctx.quadraticCurveTo(px(12), py(20), px(3), py(12));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px(12), py(12), Math.max(1.2, 2.5 * s), 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px(3), py(3));
      ctx.lineTo(px(21), py(21));
      ctx.stroke();
    } else if (typeId === 'recolor') {
      ctx.beginPath();
      ctx.moveTo(px(4), py(21));
      ctx.lineTo(px(13), py(12));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(11), py(13));
      ctx.lineTo(px(18), py(2));
      ctx.lineTo(px(22), py(5));
      ctx.lineTo(px(14), py(15));
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px(4), py(21), Math.max(1.4, 2.8 * s), 0, Math.PI * 2);
      ctx.fill();
    } else if (typeId === 'move') {
      ctx.beginPath();
      ctx.moveTo(px(5), py(9)); ctx.lineTo(px(2), py(12)); ctx.lineTo(px(5), py(15));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(9), py(5)); ctx.lineTo(px(12), py(2)); ctx.lineTo(px(15), py(5));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(15), py(19)); ctx.lineTo(px(12), py(22)); ctx.lineTo(px(9), py(19));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(19), py(9)); ctx.lineTo(px(22), py(12)); ctx.lineTo(px(19), py(15));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(2), py(12)); ctx.lineTo(px(22), py(12));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(px(12), py(2)); ctx.lineTo(px(12), py(22));
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------
  // Sidebar UI
  // ---------------------------------------------------------------
  function renderSwatch(category, type, previewHtml, extraClass) {
    // selected persists even while Place is inactive (so re-equipping
    // it restores the last choice), but the highlight itself should
    // only show while that selection is actually in effect - not just
    // remembered for later.
    const isActive = activeTool === 'place' && !!(selected && selected.category === category && selected.id === type.id);
    return `
      <button class="draw-swatch${extraClass ? ' ' + extraClass : ''}${isActive ? ' active' : ''}" data-category="${category}" data-id="${type.id}" title="${type.id}">
        ${previewHtml}
      </button>
    `;
  }

  function renderWallSwatchRow() {
    return '<div class="draw-swatch-row">' + WALL_TYPES.map((t) => renderSwatch('wall', t, wallSwatchSvg(t))).join('') + '</div>';
  }

  function renderTextureSwatchRow() {
    if (TEXTURE_TYPES.length === 0) return '<p class="menu-placeholder">More coming soon.</p>';
    return '<div class="draw-swatch-row">' + TEXTURE_TYPES.map((t) => renderSwatch('texture', t, textureSwatchSvg(t), 'draw-swatch-texture')).join('') + '</div>';
  }

  function renderStructureSwatchRow() {
    if (STRUCTURE_TYPES.length === 0) return '<p class="menu-placeholder">More coming soon.</p>';
    return '<div class="draw-swatch-row">' + STRUCTURE_TYPES.map((t) => renderSwatch('structure', t, structureSwatchSvg(t))).join('') + '</div>';
  }

  function renderLogicSwatchRow() {
    if (LOGIC_TYPES.length === 0) return '<p class="menu-placeholder">More coming soon.</p>';
    return '<div class="draw-swatch-row">' + LOGIC_TYPES.map((t) => renderSwatch('logic', t, logicSwatchSvg(t))).join('') + '</div>';
  }

  // ---------------------------------------------------------------
  // Header - the tool icons (Place/Delete) plus the Mode buttons for
  // whichever tool is active. Lives in the header rather than the
  // sidebar because the tool selector is something you reach for
  // constantly while drawing, right next to the canvas it controls,
  // not something worth a scroll down the sidebar for. Only rendered
  // while the Draw tab is the active side tab - see
  // window.SideTabHeaderRenderers.draw below. This is also where
  // map.js's actual drag behavior gets kept in sync with whatever the
  // buttons currently say.
  //
  // Place's second mode is Line when a wall is selected (walls are
  // thin edge targets - dragging to paint them one at a time is
  // essentially unusable, hence Line instead) and Drag otherwise.
  // Delete's modes are Click (single click deletes whatever's under
  // the cursor, drag pans instead - mirrors Place's Click mode) and
  // Selection (drag a rectangle, everything inside deletes on
  // release). The old always-on continuous Drag mode was dropped -
  // it was redundant with Selection for anything beyond one item, and
  // Click covers the single-item case more predictably (no risk of
  // sweeping past something on the way to your actual target).
  // ---------------------------------------------------------------
  // A classic solid pointer-arrow, matching HAMMER_ICON's filled
  // style rather than the outlined stroke style the other three use -
  // a cursor reads better solid.
  const SELECT_ICON = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M7.4 3 L7.4 19 L11.9 15.2 L15.2 21.3 L17.7 20 L14.4 13.9 L20.4 13.3 Z" fill="currentColor"/></svg>`;
  const HAMMER_ICON = `<svg viewBox="0 0 24 24" width="20" height="20"><g transform="rotate(45 12 12)"><rect x="8" y="3" width="8" height="6" rx="1" fill="currentColor"/><rect x="10.5" y="9" width="3" height="12" rx="1" fill="currentColor"/></g></svg>`;
  const DELETE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>`;
  const PAINT_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15c-2.2 0-4 1.8-4 4s1.8 2.5 4 2.5c1.6 0 2.7-.8 3-2"/><path d="M8.5 15.5c-.3-2.8.7-4.8 2.8-6.9l6-6 2.1 2.1-6 6c-2.1 2.1-4.1 3.1-6.9 2.8"/></svg>`;
  const WRENCH_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 4.6L4 16.2V20h3.8l5.3-5.3a4 4 0 0 0 4.6-5.4l-2.8 2.8-2-2 2.8-2.8Z"/></svg>`;
  const UNDO_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9,14 4,9 9,4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>`;
  const REDO_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15,14 20,9 15,4"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>`;
  const SWAP_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l-3.5-3.5"/><path d="M18 16H6l3.5 3.5"/></svg>`;
  const EYEDROPPER_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 3.5l5 5-3 3-5-5z"/><path d="M17.5 6.5l-9 9-4 1.5 1.5-4 9-9"/><path d="M6.5 17.5L4 20"/></svg>`;
  const CLOCK_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`;
  const STAR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.5l2.6 5.6 6 .6-4.5 4.1 1.3 6-5.4-3-5.4 3 1.3-6-4.5-4.1 6-.6z"/></svg>`;
  // Configure header's Settings button - an 8-tick cog, same currentColor
  // convention as the other header icons above.
  // A real cog/gear glyph (toothed ring around a center hole) - the
  // previous version was just a circle with thin radial spokes, which
  // reads as a sun/brightness icon rather than a settings gear.
  const GEAR_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

  // Order here doubles as the 1-9 hotkey order (see the keydown
  // handler near the bottom of this file) - index 0 is "1", index 1
  // is "2", and so on, up to 9 tools before running out of number
  // keys. Both the header buttons and the hotkeys read from this one
  // list so they can't drift out of sync with each other.
  // Select is first on purpose - the 1-9 hotkey handler equips
  // whichever tool sits at TOOL_DEFS[num-1], so this alone is what
  // moves every other tool's hotkey up by one (Place 1->2, Delete
  // 2->3, Paint 3->4, Configure 4->5) without touching that handler.
  // Switch's "Trigger on:" options, in dropdown order. 'pulse' is the
  // default for a freshly-placed switch (switchTriggerModes.get(key)
  // missing == 'pulse') - see renderSwitchTriggerSettings.
  const SWITCH_TRIGGER_OPTIONS = [
    { id: 'pulse', label: 'Pulse' },
    { id: 'interact', label: 'Interact' },
    { id: 'roundStart', label: 'Round Start' },
    { id: 'turnStart', label: 'Turn Start' },
  ];
  // Break/Hide/Recolor/Move's own "Trigger on:" options - identical
  // set/order/labels to Switch's, reused as-is rather than duplicated.
  const LOGIC_TRIGGER_OPTIONS = SWITCH_TRIGGER_OPTIONS;
  // Hide's "Change opacity [(to), by]" and Move's "[(to), by]" selector -
  // shared by both since they're the exact same to/by concept.
  const TO_BY_OPTIONS = [
    { id: 'to', label: 'To' },
    { id: 'by', label: 'By' },
  ];
  // Move's "[(Move), Rotate]" action selector - ids stay 'move'/'rotate'
  // (matching the underlying state/logic), only the displayed labels
  // read "Position"/"Rotation" per the person's own naming preference.
  const MOVE_ACTION_OPTIONS = [
    { id: 'move', label: 'Position' },
    { id: 'rotate', label: 'Rotation' },
  ];

  const TOOL_DEFS = [
    { id: 'select', icon: SELECT_ICON, title: 'Select' },
    { id: 'place', icon: HAMMER_ICON, title: 'Place' },
    { id: 'delete', icon: DELETE_ICON, title: 'Delete' },
    { id: 'paint', icon: PAINT_ICON, title: 'Paint' },
    { id: 'configure', icon: WRENCH_ICON, title: 'Configure' },
  ];

  // Abandons whatever wire is currently being built, if any - resets
  // the shared pendingWireSource/pendingWireDestTarget state both the
  // sidebar and header Wire-mode UIs read, closes any of their open
  // dropdowns, and refreshes every surface that shows it (map
  // highlight/live line, sidebar, header). Used when the tool closes,
  // when Configure's own mode switches away from Wire, and by the
  // sidebar's own cancel ("x") button on the pending row.
  function cancelPendingWire() {
    pendingWireSource = null;
    pendingWireDestTarget = null;
    configureWireDropdownOpen = null;
    headerWireSourceDropdownOpen = false;
    headerWireDestDropdownOpen = false;
    wireDrawColor = DEFAULT_PRIMARY_COLOR;
    wireColorPickerOpen = null;
    wireColorDragActive = false;
    wireColorDragContainer = null;
    wireHexEditing = null;
    hideMapContextMenu();
    window.BattleMap.requestRedraw();
    renderDrawTab();
    renderHeaderLeft();
  }

  // Shared by the header tool buttons and the 1-9 hotkeys - toggles a
  // tool on/off exactly the same way regardless of which one equipped
  // it, including Place's solid-wall default.
  function equipTool(toolId) {
    const wasConfigure = activeTool === 'configure';
    const wasSelect = activeTool === 'select';
    activeTool = activeTool === toolId ? null : toolId;
    if (wasConfigure && activeTool !== 'configure') {
      configureTarget = null; // "put down" means the selection goes with it, not just hidden until picked back up
      configureSettingsDropdownOpen = false;
      switchTriggerDropdownOpen = null;
      logicTriggerDropdownOpen = null;
      logicFieldDropdownOpen = null;
      cancelPendingWire(); // closing the tool abandons any wire still being built - see the person's own spec
    }
    if (wasSelect && activeTool !== 'select') {
      // A drag in progress keeps running in map.js even after the tool
      // changes out from under it (mid-drag hotkey presses aren't
      // blocked) - clearing this means handleArrangeGesture's own
      // commit just quietly no-ops instead of moving something after
      // the person's already switched away from Arrange mode.
      arrangeDragItem = null;
      arrangeDragCurrentInfo = null;
    }
    if (activeTool === 'configure' && !wasConfigure) {
      // Equipping Configure needs its own redraw request too - if it
      // was already left in Wire mode from an earlier session (mode
      // isn't reset by putting the tool down), the wires/highlight
      // should appear the instant the tool is equipped, not wait for
      // the cursor to reach the map and trigger one incidentally.
      window.BattleMap.requestRedraw();
    }
    if (activeTool === 'place' && !selected) {
      setSelected({ category: 'wall', id: 'solid' });
    }
    renderDrawTab();
    renderHeaderLeft();
  }

  // HSV/HSB - separate from the HSL pair above, used by the sidebar's
  // Paint Mode panel (hue/saturation/brightness sliders + the SV
  // square) rather than the header's wheel+lightness dropdown. Two
  // color models in one file isn't ideal, but the header picker is
  // getting reworked later anyway - no sense converting it to match a
  // system that's about to change again.
  function hsvToHex(h, s, v) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    v = Math.max(0, Math.min(100, v)) / 100;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }
  function hexToHsv(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = 60 * (((g - b) / d) % 6);
      else if (max === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    return { h, s: s * 100, v: v * 100 };
  }

  // ---------------------------------------------------------------
  // Primary/secondary color management - one place all of it goes
  // through, so the "auto-derived shade" linkage and the manual-
  // tracking flags (drive the reset buttons) can't get out of sync no
  // matter which UI surface (sidebar square/sliders, header mini
  // picker, a recent/favorite chip, the eyedropper) triggered the
  // change.
  //
  // Two entry points rather than one, and this split is what actually
  // fixes the "locks to leftmost hue" / "square shifts slightly" bugs:
  // setPaintColorHSV takes exact h/s/v and is what every in-app edit
  // (the SV square, the H/S/B sliders) goes through, so the true
  // values are always what's stored and redisplayed - never rounded
  // through hex and back. setPaintColorHex is for the few sources that
  // only ever have a hex value in the first place (a saved recent/
  // favorite color, the system eyedropper) - deriving HSV once there
  // is unavoidable, but it only happens at that boundary, not on every
  // subsequent render.
  // ---------------------------------------------------------------

  // If this is a genuine manual pick (the default for every caller
  // except the auto-derivation below itself) and the OTHER color
  // hasn't been manually set yet, the other color follows along as an
  // adjacent shade: same hue, same brightness, but offset in
  // saturation - primary always reads as more saturated than
  // secondary, whichever one was actually picked. That relationship
  // holds continuously (every drag/slider step, not just on release)
  // until the DM manually touches the other color too, at which point
  // they become independent.
  function setPaintColorHSV(target, h, s, v, { manual = true } = {}) {
    const hex = hsvToHex(h, s, v);
    if (target === 'primary') {
      paintPrimaryHSV = { h, s, v };
      paintPrimaryColor = hex;
      if (manual) primaryManuallySet = true;
    } else {
      paintSecondaryHSV = { h, s, v };
      paintSecondaryColor = hex;
      if (manual) secondaryManuallySet = true;
    }
    if (!manual) return;

    if (target === 'primary' && !secondaryManuallySet) {
      const shadeS = Math.max(0, s - SHADE_SATURATION_OFFSET);
      paintSecondaryHSV = { h, s: shadeS, v };
      paintSecondaryColor = hsvToHex(h, shadeS, v);
    } else if (target === 'secondary' && !primaryManuallySet) {
      const shadeS = Math.min(100, s + SHADE_SATURATION_OFFSET);
      paintPrimaryHSV = { h, s: shadeS, v };
      paintPrimaryColor = hsvToHex(h, shadeS, v);
    }
  }

  // For hex-only sources - derives HSV once, then defers to the exact
  // same logic above.
  function setPaintColorHex(target, hex, opts) {
    const hsv = hexToHsv(hex);
    setPaintColorHSV(target, hsv.h, hsv.s, hsv.v, opts);
  }

  // Reset means "go back to following the other color" (if that one's
  // been manually set) or, if neither ever has been, back to the
  // hardcoded base default - not necessarily the exact same hex it
  // started at, since the other color may have moved since then.
  function resetPaintColor(target) {
    if (target === 'primary') {
      primaryManuallySet = false;
      if (secondaryManuallySet) {
        const { h, s, v } = paintSecondaryHSV;
        const shadeS = Math.min(100, s + SHADE_SATURATION_OFFSET);
        paintPrimaryHSV = { h, s: shadeS, v };
        paintPrimaryColor = hsvToHex(h, shadeS, v);
      } else {
        paintPrimaryHSV = hexToHsv(DEFAULT_PRIMARY_COLOR);
        paintPrimaryColor = DEFAULT_PRIMARY_COLOR;
      }
    } else {
      secondaryManuallySet = false;
      if (primaryManuallySet) {
        const { h, s, v } = paintPrimaryHSV;
        const shadeS = Math.max(0, s - SHADE_SATURATION_OFFSET);
        paintSecondaryHSV = { h, s: shadeS, v };
        paintSecondaryColor = hsvToHex(h, shadeS, v);
      } else {
        paintSecondaryHSV = hexToHsv(DEFAULT_SECONDARY_COLOR);
        paintSecondaryColor = DEFAULT_SECONDARY_COLOR;
      }
    }
  }

  // Called on gesture END (mouseup / the slider's 'change' event, not
  // its continuous 'input') - not every intermediate step of a drag,
  // or one drag would flood the list with near-duplicate colors.
  function commitPaintColorToRecents(hex) {
    const idx = recentPaintColors.indexOf(hex);
    if (idx !== -1) recentPaintColors.splice(idx, 1);
    recentPaintColors.unshift(hex);
    if (recentPaintColors.length > MAX_RECENT_COLORS) recentPaintColors.length = MAX_RECENT_COLORS;
    persistRecentPaintColors();
  }
  function addPaintColorToFavorites(hex) {
    if (!favoritePaintColors.includes(hex)) favoritePaintColors.push(hex);
    persistFavoritePaintColors();
  }

  // Shared by both the header's swap button and the sidebar's -
  // they're the same action, just reachable from two places.
  function swapPaintColors() {
    const tmpColor = paintPrimaryColor;
    paintPrimaryColor = paintSecondaryColor;
    paintSecondaryColor = tmpColor;
    const tmpHSV = paintPrimaryHSV;
    paintPrimaryHSV = paintSecondaryHSV;
    paintSecondaryHSV = tmpHSV;
    // The manual/auto-follow relationship travels with the color, not
    // the primary/secondary slot - swapping which slot a manually-
    // picked color sits in shouldn't suddenly make it look "auto"
    // (enabled reset button flips to disabled) or the other way
    // around.
    const tmpManual = primaryManuallySet;
    primaryManuallySet = secondaryManuallySet;
    secondaryManuallySet = tmpManual;
    renderHeaderLeft();
    renderDrawTab();
  }

  // Shared by both the header's eyedropper button and the sidebar's.
  // Uses the browser's native EyeDropper API - lets the DM sample any
  // pixel on screen, not just within the map - rather than building a
  // custom crosshair-and-sample tool from scratch.
  async function activateEyedropper() {
    if (!window.EyeDropper) return; // unsupported build - button simply does nothing rather than erroring
    try {
      const result = await new window.EyeDropper().open();
      setPaintColorHex(paintColorTarget, result.sRGBHex, { manual: true });
      commitPaintColorToRecents(result.sRGBHex);
      renderDrawTab();
      renderHeaderLeft();
    } catch (e) {
      // DM pressed Escape / cancelled the pick - nothing to do
    }
  }

  // Header dropdown - a miniature version of the sidebar's own SV
  // square + H/S/B sliders (not the old separate wheel+lightness-
  // slider design, and without Recent/Favorites - those get their own
  // dedicated header buttons instead, see the clock/star buttons).
  // Distinct "header"-prefixed element ids throughout, since the
  // sidebar's own picker (same target color) can be visible on screen
  // at the same time and ids must stay unique across the whole page.
  function applyHeaderSVFromPointer(target, clientX, clientY) {
    const sq = headerLeftEl.querySelector('#headerSvSquare');
    if (!sq) { colorDragTarget = null; return; }
    const rect = sq.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100;
    const v = 100 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) * 100;
    const hueSlider = headerLeftEl.querySelector('#headerHueSlider');
    const h = hueSlider ? Number(hueSlider.value) : 0;
    setPaintColorHSV(target, h, s, v, { manual: true });
    updateHeaderPickerLive(target, h, s, v);
  }

  // The header sliders' track gradients, same dependency-on-all-three
  // logic as the sidebar's updateSliderGradients - factored out so it
  // can also run once at first wiring (see below), not just reactively
  // during a drag/slider-input.
  function updateHeaderSliderGradients(h, s, v) {
    const hueSlider = headerLeftEl.querySelector('#headerHueSlider');
    const satSlider = headerLeftEl.querySelector('#headerSatSlider');
    const valSlider = headerLeftEl.querySelector('#headerValSlider');
    if (hueSlider) hueSlider.style.setProperty('--track-gradient', 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)');
    if (satSlider) satSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, 0, v)}, ${hsvToHex(h, 100, v)})`);
    if (valSlider) valSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, s, 0)}, ${hsvToHex(h, s, 100)})`);
  }

  // Same idea as the sidebar's updatePaintPanelLive - live DOM updates
  // during a drag/slider-input without a full renderHeaderLeft(),
  // which would rebuild the square/marker out from under the drag.
  // Takes `target` explicitly (rather than reading colorDragTarget)
  // since slider-input calls this too, and colorDragTarget must stay
  // reserved for the SV-square mouse-drag only - see the module-level
  // mousemove listener at the bottom of this file, which reapplies
  // pointer coordinates against the SV square on every mousemove while
  // colorDragTarget is set. Setting it from slider input as well used
  // to make that same listener misinterpret ordinary mouse movement
  // over the sliders as SV-square drag coordinates, snapping
  // brightness toward 0 whenever the cursor drifted below the square.
  function updateHeaderPickerLive(target, h, s, v) {
    const hex = target === 'primary' ? paintPrimaryColor : paintSecondaryColor;
    const sq = headerLeftEl.querySelector('#headerSvSquare');
    if (sq) sq.style.setProperty('--sv-hue', h);
    const marker = headerLeftEl.querySelector('#headerSvMarker');
    if (marker) { marker.style.left = s + '%'; marker.style.top = (100 - v) + '%'; }
    const hueSlider = headerLeftEl.querySelector('#headerHueSlider');
    const satSlider = headerLeftEl.querySelector('#headerSatSlider');
    const valSlider = headerLeftEl.querySelector('#headerValSlider');
    if (hueSlider) hueSlider.value = h;
    if (satSlider) satSlider.value = s;
    if (valSlider) valSlider.value = v;
    updateHeaderSliderGradients(h, s, v);
    const primaryHeaderBox = document.getElementById('primaryColorBtn');
    if (primaryHeaderBox) primaryHeaderBox.style.background = paintPrimaryColor;
    const secondaryHeaderBox = document.getElementById('secondaryColorBtn');
    if (secondaryHeaderBox) secondaryHeaderBox.style.background = paintSecondaryColor;
    const primarySwatch = sideScrollEl.querySelector('.paint-preview-swatch[data-target="primary"]');
    if (primarySwatch) primarySwatch.style.background = paintPrimaryColor;
    const secondarySwatch = sideScrollEl.querySelector('.paint-preview-swatch[data-target="secondary"]');
    if (secondarySwatch) secondarySwatch.style.background = paintSecondaryColor;
  }

  function renderColorDropdown(which) {
    const hsv = which === 'primary' ? paintPrimaryHSV : paintSecondaryHSV;
    return `
      <div class="header-dropdown header-color-dropdown" data-color-target="${which}">
        <div class="sv-square sv-square-mini" id="headerSvSquare" data-color-target="${which}" style="--sv-hue:${hsv.h}">
          <div class="sv-square-marker" id="headerSvMarker" style="left:${hsv.s}%;top:${100 - hsv.v}%;"></div>
        </div>
        <div class="paint-sliders paint-sliders-mini">
          <div class="paint-slider-row">
            <label>Hue</label>
            <input type="range" id="headerHueSlider" data-color-target="${which}" min="0" max="360" value="${hsv.h}">
          </div>
          <div class="paint-slider-row">
            <label>Saturation</label>
            <input type="range" id="headerSatSlider" data-color-target="${which}" min="0" max="100" value="${hsv.s}">
          </div>
          <div class="paint-slider-row">
            <label>Brightness</label>
            <input type="range" id="headerValSlider" data-color-target="${which}" min="0" max="100" value="${hsv.v}">
          </div>
        </div>
      </div>
    `;
  }

  // Recents (clock icon): the 6 most recent colors, in a grid capped
  // at 2 columns wide / 3 rows deep - not scrollable, since it's
  // never actually asked to hold more than 6 items (3 rows' worth,
  // matching Favorites' scrollable viewport height so the two menus
  // read as the same size).
  function renderHeaderRecentDropdown() {
    return `
      <div class="header-dropdown header-mini-palette-dropdown">
        ${renderColorChipGrid(recentPaintColors.slice(0, 6), 'recent', 'header-mini-palette')}
      </div>
    `;
  }

  // Favorites (star icon): every favorited color, same 2-column grid
  // but capped to a 3-row-tall viewport and scrollable beyond that,
  // since (unlike Recents) this shows the DM's entire favorites list,
  // which has no fixed size.
  function renderHeaderFavoriteDropdown() {
    return `
      <div class="header-dropdown header-mini-palette-dropdown">
        ${renderColorChipGrid(favoritePaintColors, 'favorites', 'header-mini-palette header-mini-palette-scrollable', false)}
      </div>
    `;
  }


  // ---------------------------------------------------------------
  // Sidebar Paint Mode - replaces the usual Walls/Textures/Structures/
  // Logic sections while the Paint tool is equipped (see
  // renderDrawTab). A rectangular saturation/value square for quick
  // dragging, two stacked preview swatches for primary/secondary
  // (click either to retarget which one the square and sliders are
  // currently editing - primary selected by default, shown by a
  // bolder outline), and Hue/Saturation/Brightness sliders underneath
  // for precise entry. All of it reads/writes the exact same
  // paintPrimaryColor/paintSecondaryColor the header's boxes do, so
  // the two stay in sync automatically without any extra plumbing.
  // ---------------------------------------------------------------
  function applyHSVToTarget(h, s, v) {
    setPaintColorHSV(paintColorTarget, h, s, v, { manual: true });
    return paintColorTarget === 'primary' ? paintPrimaryColor : paintSecondaryColor;
  }

  // The three sliders' own track gradients depend on more than just
  // their own channel - saturation's gradient runs from grey to the
  // full-saturation color at the CURRENT hue and brightness, and
  // brightness's runs from black to the full-brightness color at the
  // current hue and saturation. So all three get recomputed together
  // any time any one of them changes, not just their own.
  function updateSliderGradients(h, s, v) {
    const hueSlider = sideScrollEl.querySelector('#hueSlider');
    const satSlider = sideScrollEl.querySelector('#satSlider');
    const valSlider = sideScrollEl.querySelector('#valSlider');
    if (hueSlider) {
      hueSlider.style.setProperty('--track-gradient', 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)');
    }
    if (satSlider) {
      satSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, 0, v)}, ${hsvToHex(h, 100, v)})`);
    }
    if (valSlider) {
      valSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, s, 0)}, ${hsvToHex(h, s, 100)})`);
    }
  }

  // Live DOM updates without a full renderDrawTab() - used both while
  // dragging the SV square and when a slider fires its own input
  // event, so neither one has to fully rebuild the panel (and lose
  // drag state / redraw cost) on every tiny movement.
  function updatePaintPanelLive(h, s, v, hex) {
    const svSquare = sideScrollEl.querySelector('#svSquare');
    if (svSquare) svSquare.style.setProperty('--sv-hue', h);
    const marker = sideScrollEl.querySelector('#svMarker');
    if (marker) {
      marker.style.left = s + '%';
      marker.style.top = (100 - v) + '%';
    }
    // Both preview swatches get refreshed, not just the targeted one -
    // the untargeted color may be live-following along as an
    // auto-derived shade (see setPaintColor) and needs to visually
    // keep up even though its own square/sliders aren't shown.
    const primarySwatch = sideScrollEl.querySelector('.paint-preview-swatch[data-target="primary"]');
    if (primarySwatch) primarySwatch.style.background = paintPrimaryColor;
    const secondarySwatch = sideScrollEl.querySelector('.paint-preview-swatch[data-target="secondary"]');
    if (secondarySwatch) secondarySwatch.style.background = paintSecondaryColor;
    const primaryHeaderBox = document.getElementById('primaryColorBtn');
    if (primaryHeaderBox) primaryHeaderBox.style.background = paintPrimaryColor;
    const secondaryHeaderBox = document.getElementById('secondaryColorBtn');
    if (secondaryHeaderBox) secondaryHeaderBox.style.background = paintSecondaryColor;

    const hueSlider = sideScrollEl.querySelector('#hueSlider');
    const satSlider = sideScrollEl.querySelector('#satSlider');
    const valSlider = sideScrollEl.querySelector('#valSlider');
    if (hueSlider) hueSlider.value = h;
    if (satSlider) satSlider.value = s;
    if (valSlider) valSlider.value = v;
    updateSliderGradients(h, s, v);

    // The other color's reset button may have just gone from disabled
    // to enabled (or vice versa via a reset) - and if it's still
    // following along automatically, its own manual flag never
    // changed, so a plain disabled-attribute sync is enough without a
    // full re-render.
    const primaryResetBtn = sideScrollEl.querySelector('.paint-reset-btn[data-reset-target="primary"]');
    if (primaryResetBtn) primaryResetBtn.disabled = !primaryManuallySet;
    const secondaryResetBtn = sideScrollEl.querySelector('.paint-reset-btn[data-reset-target="secondary"]');
    if (secondaryResetBtn) secondaryResetBtn.disabled = !secondaryManuallySet;
  }

  function applySVFromPointer(clientX, clientY) {
    const svSquare = sideScrollEl.querySelector('#svSquare');
    if (!svSquare) { svDragActive = false; return; }
    const rect = svSquare.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * 100;
    const v = 100 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)) * 100;
    const hueSlider = sideScrollEl.querySelector('#hueSlider');
    const h = hueSlider ? Number(hueSlider.value) : 0;
    const hex = applyHSVToTarget(h, s, v);
    updatePaintPanelLive(h, s, v, hex);
  }

  const RESET_ICON = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v5h5"/></svg>';

  function renderColorChipGrid(colors, section, gridClass = 'paint-color-grid', allowFavoriteRemove = true) {
    if (colors.length === 0) return '<p class="menu-placeholder">None yet.</p>';
    return `<div class="${gridClass}">${colors.map((hex) => {
      const showConfirm = allowFavoriteRemove && section === 'favorites' && favoriteRemoveConfirmHex === hex;
      return `
        <div class="paint-color-chip-wrap">
          <button class="paint-color-chip" data-color="${hex}" data-section="${section}" style="background:${hex}" title="${hex}"></button>
          ${showConfirm ? `
            <div class="paint-confirm-popup">
              <div class="paint-confirm-text">Remove favorite?</div>
              <div class="paint-confirm-buttons">
                <button class="paint-confirm-yes" data-confirm-remove="${hex}">Remove</button>
                <button class="paint-confirm-no">Cancel</button>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('')}</div>`;
  }

  function renderPaintModePanel() {
    const hsv = paintColorTarget === 'primary' ? paintPrimaryHSV : paintSecondaryHSV;
    return `
      <div class="paint-mode-panel">
        <div class="paint-picker-row">
          <div class="sv-square" id="svSquare" style="--sv-hue:${hsv.h}">
            <div class="sv-square-marker" id="svMarker" style="left:${hsv.s}%;top:${100 - hsv.v}%;"></div>
          </div>
          <div class="paint-preview-col">
            <div class="paint-preview-item">
              <button class="paint-preview-swatch${paintColorTarget === 'primary' ? ' selected' : ''}" data-target="primary" style="background:${paintPrimaryColor}" title="Primary"></button>
              <button class="paint-reset-btn" data-reset-target="primary" title="Reset to default" ${primaryManuallySet ? '' : 'disabled'}>${RESET_ICON}</button>
            </div>
            <div class="paint-preview-item">
              <button class="paint-preview-swatch${paintColorTarget === 'secondary' ? ' selected' : ''}" data-target="secondary" style="background:${paintSecondaryColor}" title="Secondary"></button>
              <button class="paint-reset-btn" data-reset-target="secondary" title="Reset to default" ${secondaryManuallySet ? '' : 'disabled'}>${RESET_ICON}</button>
            </div>
            <button class="header-icon-square-btn header-swap-btn" id="sidebarSwapBtn" title="Swap primary and secondary">${SWAP_ICON}</button>
            <button class="header-icon-square-btn" id="sidebarEyedropperBtn" title="Pick a color from the screen">${EYEDROPPER_ICON}</button>
          </div>
        </div>
        <div class="paint-sliders">
          <div class="paint-slider-row">
            <label>Hue</label>
            <input type="range" id="hueSlider" min="0" max="360" value="${hsv.h}">
          </div>
          <div class="paint-slider-row">
            <label>Saturation</label>
            <input type="range" id="satSlider" min="0" max="100" value="${hsv.s}">
          </div>
          <div class="paint-slider-row">
            <label>Brightness</label>
            <input type="range" id="valSlider" min="0" max="100" value="${hsv.v}">
          </div>
        </div>
      </div>

      <div class="settings-section-header draw-section-header-first"><h4>Recent</h4></div>
      ${renderColorChipGrid(recentPaintColors, 'recent')}

      <div class="settings-section-header"><h4>Favorites</h4></div>
      ${renderColorChipGrid(favoritePaintColors, 'favorites')}
    `;
  }

  function wirePaintModePanel() {
    // Slider track gradients depend on live h/s/v, so they need
    // setting on first render too, not just during drags/input.
    const initHsv = paintColorTarget === 'primary' ? paintPrimaryHSV : paintSecondaryHSV;
    updateSliderGradients(initHsv.h, initHsv.s, initHsv.v);

    sideScrollEl.querySelectorAll('.paint-preview-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        paintColorTarget = btn.dataset.target;
        renderDrawTab(); // full re-render - the square/sliders need to reflect the newly targeted color, not just live-preview it
      });
    });

    const sidebarSwapBtn = sideScrollEl.querySelector('#sidebarSwapBtn');
    if (sidebarSwapBtn) sidebarSwapBtn.addEventListener('click', swapPaintColors);
    const sidebarEyedropperBtn = sideScrollEl.querySelector('#sidebarEyedropperBtn');
    if (sidebarEyedropperBtn) sidebarEyedropperBtn.addEventListener('click', activateEyedropper);

    sideScrollEl.querySelectorAll('.paint-reset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        resetPaintColor(btn.dataset.resetTarget);
        renderDrawTab();
        renderHeaderLeft();
      });
    });

    const svSquare = sideScrollEl.querySelector('#svSquare');
    if (svSquare) {
      svSquare.addEventListener('mousedown', (e) => {
        svDragActive = true;
        applySVFromPointer(e.clientX, e.clientY);
      });
    }

    function currentHSV() {
      const hueSlider = sideScrollEl.querySelector('#hueSlider');
      const satSlider = sideScrollEl.querySelector('#satSlider');
      const valSlider = sideScrollEl.querySelector('#valSlider');
      return { h: Number(hueSlider.value), s: Number(satSlider.value), v: Number(valSlider.value) };
    }
    function onSliderInput() {
      const { h, s, v } = currentHSV();
      const hex = applyHSVToTarget(h, s, v);
      updatePaintPanelLive(h, s, v, hex);
    }
    function onSliderChange() {
      // 'change' fires once on release, unlike 'input' which fires
      // continuously - this is the actual gesture-end commit point.
      commitPaintColorToRecents(paintColorTarget === 'primary' ? paintPrimaryColor : paintSecondaryColor);
      renderDrawTab();
    }
    ['hueSlider', 'satSlider', 'valSlider'].forEach((id) => {
      const el = sideScrollEl.querySelector('#' + id);
      if (!el) return;
      el.addEventListener('input', onSliderInput);
      el.addEventListener('change', onSliderChange);
    });

    wireColorChipGrid(sideScrollEl);
  }

  // Shared by the sidebar's Recent/Favorites sections and the
  // header's Recents/Favorites dropdowns - same click-to-pick,
  // right-click-to-favorite/right-click-to-confirm-remove behavior
  // regardless of which surface it's rendered in. Always refreshes
  // both renderDrawTab() and renderHeaderLeft() since a color picked
  // from either surface needs to show up on both (the sidebar's
  // preview swatches and the header's stacked boxes are the same
  // underlying colors, just displayed twice).
  function wireColorChipGrid(container, { allowFavoriteRemove = true } = {}) {
    container.querySelectorAll('.paint-color-chip').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        favoriteRemoveConfirmHex = null; // picking a color while a confirm popup happens to be open shouldn't leave it stuck open
        const hex = chip.dataset.color;
        setPaintColorHex(paintColorTarget, hex, { manual: true });
        commitPaintColorToRecents(hex);
        renderDrawTab();
        renderHeaderLeft();
      });
      if (chip.dataset.section === 'recent') {
        chip.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          addPaintColorToFavorites(chip.dataset.color);
          renderDrawTab();
          renderHeaderLeft();
        });
      } else if (allowFavoriteRemove) {
        // Favorites - right-click asks for confirmation rather than
        // removing immediately, since there's no undo for it the way
        // there is for placed content. The header's Favorites dropdown
        // opts out of this entirely (allowFavoriteRemove: false below)
        // - favorites can only be removed from the sidebar.
        chip.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          favoriteRemoveConfirmHex = chip.dataset.color;
          renderDrawTab();
          renderHeaderLeft();
        });
      }
    });
    container.querySelectorAll('[data-confirm-remove]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const hex = btn.dataset.confirmRemove;
        const idx = favoritePaintColors.indexOf(hex);
        if (idx !== -1) favoritePaintColors.splice(idx, 1);
        persistFavoritePaintColors();
        favoriteRemoveConfirmHex = null;
        renderDrawTab();
        renderHeaderLeft();
      });
    });
    container.querySelectorAll('.paint-confirm-no').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        favoriteRemoveConfirmHex = null;
        renderDrawTab();
        renderHeaderLeft();
      });
    });
  }

  // Category picker (Place only) - Walls/Textures/Structures/Logic,
  // same four sections as the sidebar. Structures no longer needs the
  // length-check exemption now that stairs/chest exist, and neither
  // does Logic now that Switch/Breakable exist.
  const CATEGORY_DEFS = [
    { id: 'wall', label: 'Walls', types: WALL_TYPES },
    { id: 'texture', label: 'Textures', types: TEXTURE_TYPES },
    { id: 'structure', label: 'Structures', types: STRUCTURE_TYPES },
    { id: 'logic', label: 'Logic', types: LOGIC_TYPES },
  ];

  function previewForType(categoryId, type) {
    if (categoryId === 'wall') return wallSwatchSvg(type);
    if (categoryId === 'texture') return textureSwatchSvg(type);
    if (categoryId === 'structure') return structureSwatchSvg(type);
    if (categoryId === 'logic') return logicSwatchSvg(type);
    return '';
  }

  // The category/item pickers sitting between Mode and undo/redo -
  // a compact, always-visible readout of what Place currently has
  // loaded, with a click-to-change dropdown for each half instead of
  // needing to scroll the sidebar to see or change it. Visual palette
  // for the item picker for now (reusing the exact same preview
  // generators the sidebar swatches use, so they can't drift apart) -
  // per the request, a text-based version may replace this later.
  // Which category the header group displays when nothing is actually
  // selected - defaults to Walls. This is a DISPLAY fallback only; it
  // never gets written into `selected` itself, and "None" (below) is
  // never a real dropdown entry - just what the item slot shows while
  // selected is null, so the group stays visible instead of vanishing
  // (see renderSelectionGroup).
  function getDisplayCategoryId() {
    return selected ? selected.category : 'wall';
  }

  function renderSelectionGroup() {
    const categoryDef = CATEGORY_DEFS.find((c) => c.id === getDisplayCategoryId()) || CATEGORY_DEFS[0];
    const currentType = selected ? categoryDef.types.find((t) => t.id === selected.id) : null;

    const categoryDropdownHtml = categoryDropdownOpen ? `
      <div class="header-dropdown header-category-dropdown">
        ${CATEGORY_DEFS.map((c) => `
          <button class="header-dropdown-item${c.id === categoryDef.id ? ' active' : ''}" data-category-choice="${c.id}" ${c.types.length === 0 ? 'disabled' : ''}>${c.label}</button>
        `).join('')}
      </div>
    ` : '';

    const itemDropdownHtml = itemDropdownOpen ? `
      <div class="header-dropdown header-item-dropdown">
        ${categoryDef.types.map((t) => `
          <button class="header-dropdown-swatch${(selected && t.id === selected.id) ? ' active' : ''}" data-item-choice="${t.id}" title="${t.id}">
            ${previewForType(categoryDef.id, t)}
          </button>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="header-selection-group">
        <div class="header-selection-item">
          <button class="header-selection-btn" id="categorySelectBtn">${categoryDef.label}<span class="header-caret">&#9662;</span></button>
          ${categoryDropdownHtml}
        </div>
        <div class="header-selection-item">
          <button class="header-selection-btn header-selection-preview-btn" id="itemSelectBtn">${currentType ? previewForType(categoryDef.id, currentType) : 'None'}<span class="header-caret">&#9662;</span></button>
          ${itemDropdownHtml}
        </div>
      </div>
    `;
  }

  function syncDragBehavior() {
    if (activeTool === 'select') {
      // Arrange needs the map's real 'arrange' drag gesture (see
      // handleArrangeGesture); Interact is click-only, same click-to-
      // act/drag-to-pan convention every other click-based mode uses.
      window.BattleMap.setDragBehavior(selectMode === 'arrange' ? 'arrange' : 'pan');
      return;
    }
    if (activeTool === 'place') {
      if (placeMode === 'click') window.BattleMap.setDragBehavior('pan');
      else if (placeMode === 'line') window.BattleMap.setDragBehavior('line');
      else window.BattleMap.setDragBehavior('paint'); // 'drag'
      return;
    }
    if (activeTool === 'delete') {
      // 'click' mirrors Place's Click mode - a single click deletes
      // whatever's under the cursor, drag pans instead ('pan' drag
      // behavior, same as Place/Configure's click-only modes). Replaces
      // the old always-on continuous 'drag' mode, which was redundant
      // with Selection for anything beyond a single item.
      window.BattleMap.setDragBehavior(deleteMode === 'select' ? 'select' : 'pan');
      return;
    }
    if (activeTool === 'paint') {
      window.BattleMap.setDragBehavior(paintMode === 'click' ? 'pan' : 'paint');
      return;
    }
    if (activeTool === 'configure') {
      window.BattleMap.setDragBehavior('pan'); // click to select, drag to pan - no drag-select yet, see the header comment on configureTarget
      return;
    }
    window.BattleMap.setDragBehavior('pan');
  }

  function renderHeaderLeft() {
    syncDragBehavior();
    if (!headerLeftEl) return;

    // Once a tool is equipped, its button is the only one left - both
    // the way back out (click it again to deselect, same as ever) and
    // a plain readout of what's currently active, rather than making
    // the DM hunt for it among buttons that don't apply anymore.
    const visibleTools = activeTool ? TOOL_DEFS.filter((t) => t.id === activeTool) : TOOL_DEFS;

    const toolsHtml = `
      <div class="header-tool-row">
        ${visibleTools.map((t) => `<button class="header-tool-btn${activeTool === t.id ? ' active' : ''}" data-tool="${t.id}" title="${t.title}">${t.icon}</button>`).join('')}
      </div>
    `;

    let modeHtml = '';
    if (activeTool === 'select') {
      modeHtml = `
        <div class="header-mode-group">
          <div class="header-mode-label">Mode</div>
          <div class="header-mode-buttons">
            <button class="header-mode-btn${selectMode === 'arrange' ? ' active' : ''}" data-mode="arrange">Arrange</button>
            <button class="header-mode-btn${selectMode === 'interact' ? ' active' : ''}" data-mode="interact">Interact</button>
          </div>
        </div>
        <div class="header-undo-redo-group">
          <button class="header-icon-btn" id="undoBtn" title="Undo" ${undoStack.length === 0 ? 'disabled' : ''}>${UNDO_ICON}</button>
          <button class="header-icon-btn" id="redoBtn" title="Redo" ${redoStack.length === 0 ? 'disabled' : ''}>${REDO_ICON}</button>
        </div>
      `;
    } else if (activeTool === 'place' || activeTool === 'delete') {
      let buttons;
      if (activeTool === 'place') {
        const secondMode = (selected && selected.category === 'wall') ? 'line' : 'drag';
        const secondLabel = secondMode === 'line' ? 'Line' : 'Drag';
        buttons = [
          { mode: 'click', label: 'Click', active: placeMode === 'click' },
          { mode: secondMode, label: secondLabel, active: placeMode === secondMode },
        ];
      } else {
        buttons = [
          { mode: 'click', label: 'Click', active: deleteMode === 'click' },
          { mode: 'select', label: 'Selection', active: deleteMode === 'select' },
        ];
      }
      modeHtml = `
        <div class="header-mode-group">
          <div class="header-mode-label">Mode</div>
          <div class="header-mode-buttons">
            ${buttons.map((b) => `<button class="header-mode-btn${b.active ? ' active' : ''}" data-mode="${b.mode}">${b.label}</button>`).join('')}
          </div>
        </div>
        ${activeTool === 'place' ? renderSelectionGroup() : ''}
        <div class="header-undo-redo-group">
          <button class="header-icon-btn" id="undoBtn" title="Undo" ${undoStack.length === 0 ? 'disabled' : ''}>${UNDO_ICON}</button>
          <button class="header-icon-btn" id="redoBtn" title="Redo" ${redoStack.length === 0 ? 'disabled' : ''}>${REDO_ICON}</button>
        </div>
      `;
    } else if (activeTool === 'paint') {
      modeHtml = `
        <div class="header-mode-group">
          <div class="header-mode-label">Mode</div>
          <div class="header-mode-buttons">
            <button class="header-mode-btn${paintMode === 'click' ? ' active' : ''}" data-mode="click">Click</button>
            <button class="header-mode-btn${paintMode === 'drag' ? ' active' : ''}" data-mode="drag">Drag</button>
          </div>
        </div>
        <div class="header-paint-group">
          <div class="header-color-stack">
            <div class="header-color-box-wrap">
              <button class="header-color-box" id="primaryColorBtn" style="background:${paintPrimaryColor}"></button>
              ${colorDropdownOpen === 'primary' ? renderColorDropdown('primary') : ''}
            </div>
            <div class="header-color-box-wrap">
              <button class="header-color-box" id="secondaryColorBtn" style="background:${paintSecondaryColor}"></button>
              ${colorDropdownOpen === 'secondary' ? renderColorDropdown('secondary') : ''}
            </div>
          </div>
          <button class="header-icon-square-btn header-swap-btn" id="swapColorsBtn" title="Swap primary and secondary">${SWAP_ICON}</button>
          <button class="header-icon-square-btn" id="eyedropperBtn" title="Pick a color from the screen">${EYEDROPPER_ICON}</button>
          <div class="header-color-box-wrap">
            <button class="header-icon-square-btn" id="headerRecentBtn" title="Recent colors">${CLOCK_ICON}</button>
            ${headerRecentDropdownOpen ? renderHeaderRecentDropdown() : ''}
          </div>
          <div class="header-color-box-wrap">
            <button class="header-icon-square-btn" id="headerFavoriteBtn" title="Favorite colors">${STAR_ICON}</button>
            ${headerFavoriteDropdownOpen ? renderHeaderFavoriteDropdown() : ''}
          </div>
        </div>
        <div class="header-undo-redo-group">
          <button class="header-icon-btn" id="undoBtn" title="Undo" ${undoStack.length === 0 ? 'disabled' : ''}>${UNDO_ICON}</button>
          <button class="header-icon-btn" id="redoBtn" title="Redo" ${redoStack.length === 0 ? 'disabled' : ''}>${REDO_ICON}</button>
        </div>
      `;
    } else if (activeTool === 'configure') {
      // Edit is the only real mode today - Wire is a placeholder until
      // the actual wiring feature exists (see renderConfigurePanel).
      // No Selection-Group here, matching Configure's existing header
      // footprint - Configure never had a "what am I about to place"
      // preview to show. Undo/redo are shared globally, so it gets the
      // same cluster as every other tool.
      modeHtml = `
        <div class="header-mode-group">
          <div class="header-mode-label">Mode</div>
          <div class="header-mode-buttons">
            <button class="header-mode-btn${configureMode === 'edit' ? ' active' : ''}" data-mode="edit">Edit</button>
            <button class="header-mode-btn${configureMode === 'wire' ? ' active' : ''}" data-mode="wire">Wire</button>
          </div>
        </div>
        ${configureMode === 'edit' ? renderHeaderEditPickers() : ''}
        ${configureMode === 'wire' ? renderHeaderWirePickers() : ''}
        <div class="header-undo-redo-group">
          <button class="header-icon-btn" id="undoBtn" title="Undo" ${undoStack.length === 0 ? 'disabled' : ''}>${UNDO_ICON}</button>
          <button class="header-icon-btn" id="redoBtn" title="Redo" ${redoStack.length === 0 ? 'disabled' : ''}>${REDO_ICON}</button>
        </div>
      `;
    }

    headerLeftEl.innerHTML = toolsHtml + modeHtml;

    headerLeftEl.querySelectorAll('.header-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => equipTool(btn.dataset.tool));
    });
    headerLeftEl.querySelectorAll('.header-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (activeTool === 'select') {
          selectMode = btn.dataset.mode;
          arrangeDragItem = null; // switching mode abandons any drag still in progress
          arrangeDragCurrentInfo = null;
          window.BattleMap.requestRedraw();
        }
        else if (activeTool === 'place') placeMode = btn.dataset.mode;
        else if (activeTool === 'delete') deleteMode = btn.dataset.mode;
        else if (activeTool === 'configure') {
          configureMode = btn.dataset.mode;
          cancelPendingWire(); // switching mode abandons any wire still being built, same as closing the tool
        }
        else paintMode = btn.dataset.mode;
        renderHeaderLeft();
      });
    });

    wireHeaderConfigureDetails();

    // Header's Wire-mode pickers - same pendingWireSource/
    // pendingWireDestTarget state and commit logic the sidebar flow
    // uses (see wireConfigurePanel's own wire handlers), just a second
    // entry point into it. The source box stays live even after a
    // source is already picked, so re-opening it and choosing a
    // DIFFERENT item repoints pendingWireSource without starting over
    // - that's the whole reason this surface exists (see
    // renderHeaderWirePickers' own comment).
    const headerWireSourceBtn = headerLeftEl.querySelector('#headerWireSourceBtn');
    if (headerWireSourceBtn) {
      headerWireSourceBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        headerWireDestDropdownOpen = false;
        headerWireSourceDropdownOpen = !headerWireSourceDropdownOpen;
        renderHeaderLeft();
      });
    }
    headerLeftEl.querySelectorAll('[data-header-wire-source-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingWireSource = { key: btn.dataset.headerWireSourceKey, category: btn.dataset.headerWireSourceCategory };
        pendingWireDestTarget = null; // picking a new source starts the destination side fresh
        headerWireSourceDropdownOpen = false;
        hideMapContextMenu(); // clears a stale destination-picker left over from whatever wire (if any) was in progress before
        window.BattleMap.requestRedraw(); // the source highlight needs to show up immediately
        renderHeaderLeft();
        renderDrawTab(); // the sidebar's own view of pendingWireSource needs to stay in sync
      });
    });
    const headerWireDestBtn = headerLeftEl.querySelector('#headerWireDestBtn');
    if (headerWireDestBtn) {
      headerWireDestBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        headerWireSourceDropdownOpen = false;
        headerWireDestDropdownOpen = !headerWireDestDropdownOpen;
        renderHeaderLeft();
      });
    }
    headerLeftEl.querySelectorAll('[data-header-wire-target-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled || !pendingWireSource) return;
        pushUndoSnapshot();
        wires.push({
          fromKey: pendingWireSource.key,
          fromCategory: pendingWireSource.category,
          toKey: btn.dataset.headerWireTargetKey,
          toCategory: btn.dataset.headerWireTargetCategory,
          color: wireDrawColor,
        });
        pendingWireSource = null;
        pendingWireDestTarget = null;
        headerWireDestDropdownOpen = false;
        hideMapContextMenu(); // stale otherwise if the map's own popup was showing when this got completed via the header instead
        window.BattleMap.requestRedraw();
        renderHeaderLeft();
        renderDrawTab();
      });
    });

    wireWireColorRows(headerLeftEl, renderHeaderLeft);

    const undoBtn = headerLeftEl.querySelector('#undoBtn');
    if (undoBtn) undoBtn.addEventListener('click', undo);
    const redoBtn = headerLeftEl.querySelector('#redoBtn');
    if (redoBtn) redoBtn.addEventListener('click', redo);

    const primaryColorBtn = headerLeftEl.querySelector('#primaryColorBtn');
    if (primaryColorBtn) {
      primaryColorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        colorDropdownOpen = colorDropdownOpen === 'primary' ? null : 'primary';
        headerRecentDropdownOpen = false;
        headerFavoriteDropdownOpen = false;
        renderHeaderLeft();
      });
    }
    const secondaryColorBtn = headerLeftEl.querySelector('#secondaryColorBtn');
    if (secondaryColorBtn) {
      secondaryColorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        colorDropdownOpen = colorDropdownOpen === 'secondary' ? null : 'secondary';
        headerRecentDropdownOpen = false;
        headerFavoriteDropdownOpen = false;
        renderHeaderLeft();
      });
    }
    const swapColorsBtn = headerLeftEl.querySelector('#swapColorsBtn');
    if (swapColorsBtn) swapColorsBtn.addEventListener('click', swapPaintColors);
    const eyedropperBtn = headerLeftEl.querySelector('#eyedropperBtn');
    if (eyedropperBtn) eyedropperBtn.addEventListener('click', activateEyedropper);

    const headerRecentBtn = headerLeftEl.querySelector('#headerRecentBtn');
    if (headerRecentBtn) {
      headerRecentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        headerRecentDropdownOpen = !headerRecentDropdownOpen;
        headerFavoriteDropdownOpen = false;
        colorDropdownOpen = null;
        renderHeaderLeft();
      });
    }
    const headerFavoriteBtn = headerLeftEl.querySelector('#headerFavoriteBtn');
    if (headerFavoriteBtn) {
      headerFavoriteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        headerFavoriteDropdownOpen = !headerFavoriteDropdownOpen;
        headerRecentDropdownOpen = false;
        colorDropdownOpen = null;
        renderHeaderLeft();
      });
    }
    if (headerRecentDropdownOpen || headerFavoriteDropdownOpen) wireColorChipGrid(headerLeftEl, { allowFavoriteRemove: false });

    const headerColorDropdown = headerLeftEl.querySelector('.header-color-dropdown');
    if (headerColorDropdown) {
      // The SV square's mousedown already stops propagation, and each
      // slider's own click listener below does too, but that still
      // leaves the dropdown's padding/labels/gaps uncovered - a click
      // that lands on any of those bubbles to the document-level
      // outside-click handler and closes the dropdown. Stopping it at
      // the container level covers the whole dropdown in one place.
      headerColorDropdown.addEventListener('click', (e) => e.stopPropagation());
    }

    const headerSvSquare = headerLeftEl.querySelector('#headerSvSquare');
    if (headerSvSquare) {
      const target = headerSvSquare.dataset.colorTarget;
      // Slider track gradients depend on live h/s/v, so they need
      // setting on first render too, not just during drags/input -
      // otherwise they show blank/default until the user first touches
      // one (see updateHeaderSliderGradients).
      const initHsv = target === 'primary' ? paintPrimaryHSV : paintSecondaryHSV;
      updateHeaderSliderGradients(initHsv.h, initHsv.s, initHsv.v);
      headerSvSquare.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        colorDragTarget = target;
        applyHeaderSVFromPointer(target, e.clientX, e.clientY);
      });

      function headerSliderInput() {
        const h = Number(headerLeftEl.querySelector('#headerHueSlider').value);
        const s = Number(headerLeftEl.querySelector('#headerSatSlider').value);
        const v = Number(headerLeftEl.querySelector('#headerValSlider').value);
        setPaintColorHSV(target, h, s, v, { manual: true });
        updateHeaderPickerLive(target, h, s, v);
      }
      function headerSliderChange() {
        commitPaintColorToRecents(target === 'primary' ? paintPrimaryColor : paintSecondaryColor);
      }
      ['headerHueSlider', 'headerSatSlider', 'headerValSlider'].forEach((id) => {
        const el = headerLeftEl.querySelector('#' + id);
        if (!el) return;
        el.addEventListener('click', (e) => e.stopPropagation());
        el.addEventListener('input', headerSliderInput);
        el.addEventListener('change', headerSliderChange);
      });
    }

    const categorySelectBtn = headerLeftEl.querySelector('#categorySelectBtn');
    if (categorySelectBtn) {
      categorySelectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        categoryDropdownOpen = !categoryDropdownOpen;
        itemDropdownOpen = false;
        renderHeaderLeft();
      });
    }
    const itemSelectBtn = headerLeftEl.querySelector('#itemSelectBtn');
    if (itemSelectBtn) {
      itemSelectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        itemDropdownOpen = !itemDropdownOpen;
        categoryDropdownOpen = false;
        renderHeaderLeft();
      });
    }
    headerLeftEl.querySelectorAll('[data-category-choice]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const catDef = CATEGORY_DEFS.find((c) => c.id === btn.dataset.categoryChoice);
        if (!catDef || catDef.types.length === 0) return; // nothing to select yet from an empty category
        // Restores whatever was last chosen in this category, if
        // anything - only falls back to the first item the very
        // first time this category's ever been switched to.
        const remembered = lastSelectedByCategory[catDef.id];
        const stillValid = remembered && catDef.types.some((t) => t.id === remembered);
        setSelected({ category: catDef.id, id: stillValid ? remembered : catDef.types[0].id });
        // Same non-reset rule as picking a swatch in the sidebar -
        // only the concrete meaning of the non-Click slot adapts.
        if (placeMode !== 'click') placeMode = (catDef.id === 'wall') ? 'line' : 'drag';
        categoryDropdownOpen = false;
        renderDrawTab();
        renderHeaderLeft();
      });
    });
    headerLeftEl.querySelectorAll('[data-item-choice]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // getDisplayCategoryId(), not selected.category directly - this
        // dropdown is reachable with selected === null (defaults to
        // Walls in that case), and selected.category would throw.
        setSelected({ category: getDisplayCategoryId(), id: btn.dataset.itemChoice });
        itemDropdownOpen = false;
        renderDrawTab();
        renderHeaderLeft();
      });
    });
  }

  // Color helpers shared by all three placed-content categories -
  // reads/writes whichever map actually stores that category's
  // overrides, so the rest of the Configure color UI doesn't need to
  // know the difference.
  function colorMapFor(category) {
    // 'logic' only ever reaches here for a Recolor piece's own "Set
    // Color" swatch (renderRecolorColorField calls renderConfigureColorRow
    // directly, bypassing the generic hasColors/Colors-subsection flow
    // that the other three categories go through) - recolorColors is
    // its dedicated per-instance store, same shape as the others.
    return category === 'wall' ? wallColors : category === 'texture' ? textureColors : category === 'logic' ? recolorColors : structureColors;
  }
  function getItemColorOverride(item) {
    return colorMapFor(item.category).get(item.key) || {};
  }
  function setItemColorOverride(item, which, hex) {
    const map = colorMapFor(item.category);
    map.set(item.key, { ...(map.get(item.key) || {}), [which]: hex });
  }
  function clearItemColorOverride(item, which) {
    const map = colorMapFor(item.category);
    const current = map.get(item.key);
    if (!current) return;
    const next = { ...current };
    delete next[which];
    if (Object.keys(next).length === 0) map.delete(item.key);
    else map.set(item.key, next);
  }
  // What each category renders as when nothing's been manually set -
  // matches what drawWallSegment/drawTexture/drawStructure actually
  // fall back to. Texture's secondary has no real "default" (an
  // unpainted texture just stays transparent, showing the map
  // through) - DEFAULT_SECONDARY_COLOR is shown here only as the
  // closest visual approximation for the swatch, not because it's
  // literally what gets painted.
  function defaultColorsFor(item) {
    if (item.category === 'wall') return { primary: WALL_COLOR };
    if (item.category === 'texture') {
      const type = findType('texture', item.typeId);
      return { primary: (type && type.color) || DEFAULT_PRIMARY_COLOR, secondary: DEFAULT_SECONDARY_COLOR };
    }
    if (item.category === 'logic') return { primary: DEFAULT_PRIMARY_COLOR }; // Recolor's "Set Color" - single color, no secondary concept
    return { primary: DEFAULT_PRIMARY_COLOR, secondary: DEFAULT_SECONDARY_COLOR };
  }

  // Gathers whatever's at a given target (an edge or a cell, same
  // shape configureTarget itself takes) into the fixed display order
  // (Wall, Texture, Structure, Logic, Creature) - shared by Edit
  // mode's own listing and Wire mode's source/destination pickers, so
  // there's exactly one place that knows how to read "what's here".
  // Edge wins over the cell it borders (see handleMapClick's configure
  // branch) - an edge target only ever populates Wall/Structure(door)/
  // Logic-on-that-edge; a plain tile target only ever populates
  // Texture/Structure/Logic-on-that-cell. Creature still has nothing
  // to check yet - listed in the comment, not the code, until there's
  // an actual map to read from.
  function itemsAtTarget(target) {
    const items = [];
    if (!target) return items;
    if (target.edge) {
      const eKey = wallKey(target.edge);
      const wallTypeId = walls.get(eKey);
      if (wallTypeId) items.push({ category: 'wall', typeId: wallTypeId, key: eKey });
      if (doors.has(eKey)) items.push({ category: 'structure', typeId: 'door', key: eKey });
      const logicTypeId = logic.get(eKey);
      if (logicTypeId) items.push({ category: 'logic', typeId: logicTypeId, key: eKey });
    } else {
      const cKey = cellKey(target.col, target.row);
      const textureTypeId = textures.get(cKey);
      if (textureTypeId) items.push({ category: 'texture', typeId: textureTypeId, key: cKey });
      const structureTypeId = structures.get(cKey);
      if (structureTypeId) items.push({ category: 'structure', typeId: structureTypeId, key: cKey });
      const logicTypeId = logic.get(cKey);
      if (logicTypeId) items.push({ category: 'logic', typeId: logicTypeId, key: cKey });
    }
    return items;
  }

  // The header's Edit-mode item picker resolves to a concrete item
  // through here rather than reading configureSelectedItem directly -
  // it auto-focuses the sole item whenever the current target has
  // exactly one (so the header comes up already pointed at something
  // useful without a click), keeps whatever was explicitly chosen as
  // long as it's still actually present at this target, and otherwise
  // (nothing chosen yet, or more than one item and none picked) reads
  // as unresolved - the dropdown then shows "None" and stays dimmed
  // until the DM picks one, same "None until chosen" convention as the
  // wire pickers.
  function getConfigureSelectedItem() {
    if (!configureTarget) return null;
    const items = itemsAtTarget(configureTarget);
    if (items.length === 0) return null;
    if (configureSelectedItem) {
      const match = items.find((it) => it.key === configureSelectedItem.key && it.category === configureSelectedItem.category);
      if (match) return match;
    }
    if (items.length === 1) return items[0];
    return null;
  }

  function renderConfigurePanel() {
    const header = '<div class="settings-section-header draw-section-header-first"><h4>Configure</h4></div>';

    if (configureMode === 'wire') {
      return renderWirePanel(header);
    }

    if (!configureTarget) {
      return `${header}<p class="menu-placeholder">No tile or line selected.</p>`;
    }

    const items = itemsAtTarget(configureTarget);

    if (items.length === 0) {
      return `${header}<p class="menu-placeholder">Nothing here.</p>`;
    }

    const rows = items.map((item) => renderConfigureItem(item)).join('');
    return `${header}<div class="configure-item-list">${rows}</div>`;
  }

  // Which per-instance rotation Map a given item actually lives in -
  // doors are edge-keyed but stored in `doors` itself (presence +
  // rotation collapsed into one value, see that Map's own comment);
  // every other structure uses structureRotations; textures use their
  // own textureRotations. Logic never reaches this - hasRotation is
  // false for it below, so it's not included here at all.
  function rotationMapFor(item) {
    if (item.typeId === 'door') return doors;
    if (item.category === 'texture') return textureRotations;
    return structureRotations;
  }

  // Wire mode - a small standalone sibling to the Edit-mode item list
  // above, sharing itemsAtTarget() but with entirely different rows:
  // no rotation/colors/settings, just a "+" to start a wire from that
  // item, whatever wires already exist from it, and (for whichever
  // item currently has a wire in progress) a live destination picker.
  function sameWireEndpoint(a, b) {
    return !!a && !!b && a.key === b.key && a.category === b.category;
  }
  function typeIdAtKeyCategory(key, category) {
    if (category === 'wall') return walls.get(key);
    if (category === 'texture') return textures.get(key);
    if (category === 'logic') return logic.get(key);
    if (category === 'structure') return doors.has(key) ? 'door' : structures.get(key);
    return undefined;
  }
  // The closed/definitive display for a wire endpoint - just the
  // specific item (e.g. "Lever"), no category prefix - used for the
  // CLOSED display of a wire endpoint (the reopen button, the header's
  // source button once something's picked). Dropdown OPTIONS use the
  // fuller wireEndpointFullLabel below instead ("Structure: Lever") -
  // explicitly asked for even though at most one item per category can
  // occupy a given location, so the category alone would technically
  // disambiguate on its own.
  function wireEndpointLabel(key, category) {
    const typeId = typeIdAtKeyCategory(key, category);
    if (!typeId) return 'Unknown';
    return typeId.charAt(0).toUpperCase() + typeId.slice(1);
  }
  function wireEndpointFullLabel(key, category) {
    const typeId = typeIdAtKeyCategory(key, category);
    if (!typeId) return 'Unknown';
    return `${category.charAt(0).toUpperCase() + category.slice(1)}: ${typeId.charAt(0).toUpperCase() + typeId.slice(1)}`;
  }
  // A wire's own color row - same .configure-color-row/.configure-
  // color-chip/reset-button markup Edit mode's own color rows use, and
  // now the same SV-square-plus-sliders picker too (see
  // renderWireColorPicker) rather than a native <input type="color"> -
  // one shared picker "language" across the whole app, per the
  // person's own direction, rather than three different color-picking
  // experiences depending on which panel you're in. `idKey` is
  // 'pending' for the header's own row (edits wireDrawColor, the color
  // new wires start with) or a wires[] index as a string (edits that
  // wire's own color) - see wireColorHex/setWireColorHex.
  function renderWireColorRow(hex, idKey) {
    const isManual = hex !== DEFAULT_PRIMARY_COLOR;
    const isPickerOpen = wireColorPickerOpen === idKey;
    const isHexEditing = wireHexEditing === idKey;
    return `
      <div class="configure-color-row configure-wire-color-row">
        <div class="configure-color-chip">
          <button class="configure-color-circle-btn" style="background:${hex}" data-wire-color-id="${idKey}" title="Choose color"></button>
          ${isHexEditing
            ? `<input type="text" class="configure-wire-hex-input" data-wire-hex-id="${idKey}" value="${hex}" maxlength="7" spellcheck="false">`
            : `<button class="configure-wire-hex-btn" data-wire-hex-id="${idKey}">${hex}</button>`}
        </div>
        <button class="configure-wire-reset-btn" data-wire-reset-id="${idKey}" title="Reset to default" ${isManual ? '' : 'disabled'}>${RESET_ICON}</button>
        ${isPickerOpen ? renderWireColorPicker(hex) : ''}
      </div>
    `;
  }
  // Same SV-square-plus-sliders picker as Configure's own
  // (renderConfigureColorPicker) and the header's Paint mini-picker -
  // same CSS classes, so it looks identical - but its own fixed
  // element ids (wireSvSquare, not configureSvSquare) so its drag
  // wiring stays independent. Only one of these three pickers is ever
  // open at once in practice, but distinct ids keep that an
  // observation rather than a requirement.
  function renderWireColorPicker(hex) {
    const hsv = hexToHsv(hex);
    const hueGradient = 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)';
    const satGradient = `linear-gradient(to right, ${hsvToHex(hsv.h, 0, hsv.v)}, ${hsvToHex(hsv.h, 100, hsv.v)})`;
    const valGradient = `linear-gradient(to right, ${hsvToHex(hsv.h, hsv.s, 0)}, ${hsvToHex(hsv.h, hsv.s, 100)})`;
    return `
      <div class="header-dropdown header-color-dropdown configure-color-dropdown">
        <div class="sv-square sv-square-mini" id="wireSvSquare" style="--sv-hue:${hsv.h}">
          <div class="sv-square-marker" id="wireSvMarker" style="left:${hsv.s}%;top:${100 - hsv.v}%;"></div>
        </div>
        <div class="paint-sliders paint-sliders-mini">
          <div class="paint-slider-row"><label>Hue</label><input type="range" id="wireHueSlider" min="0" max="360" value="${hsv.h}" style="--track-gradient: ${hueGradient}"></div>
          <div class="paint-slider-row"><label>Saturation</label><input type="range" id="wireSatSlider" min="0" max="100" value="${hsv.s}" style="--track-gradient: ${satGradient}"></div>
          <div class="paint-slider-row"><label>Brightness</label><input type="range" id="wireValSlider" min="0" max="100" value="${hsv.v}" style="--track-gradient: ${valGradient}"></div>
        </div>
      </div>
    `;
  }
  function wireColorHex(idKey) {
    if (idKey === 'pending') return wireDrawColor;
    const w = wires[Number(idKey)];
    return (w && w.color) || DEFAULT_PRIMARY_COLOR;
  }
  function setWireColorHex(idKey, hex) {
    if (idKey === 'pending') { wireDrawColor = hex; return; }
    const w = wires[Number(idKey)];
    if (w) w.color = hex;
  }
  // Shared wiring for a wire color row, since the exact same row
  // appears in two different containers - once per committed wire in
  // the sidebar, once for wireDrawColor in the header - and needs the
  // same behavior in both. `rerender` is whichever of renderDrawTab/
  // renderHeaderLeft actually rebuilds the container the row lives in.
  // The SV-square/slider drag itself is driven by the two window-level
  // mousemove/mouseup listeners near the bottom of this file (mirrors
  // Configure's own configureColorDragActive pattern) rather than
  // anything scoped to this function, since a drag can continue after
  // the mouse leaves the square itself.
  function wireWireColorRows(containerEl, rerender) {
    containerEl.querySelectorAll('.configure-color-circle-btn[data-wire-color-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idKey = btn.dataset.wireColorId;
        const alreadyOpen = wireColorPickerOpen === idKey;
        if (!alreadyOpen) pushUndoSnapshot(); // one undo step covers the whole editing session, not each individual drag tick
        wireColorPickerOpen = alreadyOpen ? null : idKey;
        wireColorDragContainer = containerEl;
        wireHexEditing = null;
        rerender();
        window.BattleMap.requestRedraw();
      });
    });
    containerEl.querySelectorAll('.configure-wire-hex-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        wireHexEditing = btn.dataset.wireHexId;
        wireColorPickerOpen = null;
        rerender();
        const input = containerEl.querySelector('.configure-wire-hex-input');
        if (input) { input.focus(); input.select(); }
      });
    });
    containerEl.querySelectorAll('.configure-wire-hex-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      const commit = () => {
        const idKey = input.dataset.wireHexId;
        let val = input.value.trim();
        if (val && !val.startsWith('#')) val = '#' + val;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          pushUndoSnapshot();
          setWireColorHex(idKey, val.toLowerCase());
          window.BattleMap.requestRedraw();
        }
        wireHexEditing = null;
        rerender();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { wireHexEditing = null; rerender(); }
      });
      input.addEventListener('blur', commit);
    });
    containerEl.querySelectorAll('.configure-wire-reset-btn').forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        setWireColorHex(btn.dataset.wireResetId, DEFAULT_PRIMARY_COLOR);
        window.BattleMap.requestRedraw();
        rerender();
      });
    });
    const colorDropdown = containerEl.querySelector('.configure-color-dropdown');
    if (colorDropdown) colorDropdown.addEventListener('click', (e) => e.stopPropagation());
    const svSquare = containerEl.querySelector('#wireSvSquare');
    if (svSquare) {
      svSquare.addEventListener('mousedown', (e) => {
        wireColorDragActive = true;
        wireColorDragContainer = containerEl;
        applyWireSVFromPointer(e.clientX, e.clientY);
      });
    }
    ['wireHueSlider', 'wireSatSlider', 'wireValSlider'].forEach((id) => {
      const el = containerEl.querySelector('#' + id);
      if (el) el.addEventListener('input', () => applyWireSliderInput(containerEl));
    });
  }

  // Tracks which range sliders (the opacity sliders below) have already
  // had their one undo snapshot pushed for the CURRENT drag/keyboard
  // gesture, so a whole drag - or a run of arrow-key presses - is one
  // undo step, not one per 'input' tick. Cleared on 'change' (drag end/
  // key release), same "one snapshot per gesture" convention as the
  // color picker's own drag handling elsewhere in this file.
  const rangeGestureSnapshotted = new WeakSet();

  // Every click/input handler shared by Break/Hide/Recolor/Move's
  // Settings controls - called from both wireConfigurePanel (sideScrollEl)
  // and wireHeaderConfigureDetails (headerLeftEl), same shared-helper
  // convention as wireWireColorRows above, so the sidebar and header
  // copies of these controls can never drift out of sync with each other.
  function wireLogicSettingsControls(containerEl, rerender) {
    const FIELD_DEFS = {
      opacityMode: { flatMap: hideOpacityMode, stepsMap: hideSequenceSteps, stepProp: 'opacityMode' },
      moveAction: { flatMap: moveAction, stepsMap: moveSequenceSteps, stepProp: 'action' },
      moveMode: { flatMap: moveMode, stepsMap: moveSequenceSteps, stepProp: 'mode' },
    };
    const DIRECTION_DEFS = {
      hideOpacityByDirection: { flatMap: hideOpacityByDirection, stepsMap: hideSequenceSteps, stepProp: 'opacityByDirection' },
      moveRotateAdjustDirection: { flatMap: moveRotateAdjustDirection, stepsMap: moveSequenceSteps, stepProp: 'rotateAdjustDirection' },
    };
    const VECTOR_MAP_DEFS = {
      moveNewPosition: { flatMap: moveNewPosition, stepsMap: moveSequenceSteps, stepProp: 'newPosition' },
      moveAdjust: { flatMap: moveAdjust, stepsMap: moveSequenceSteps, stepProp: 'adjust' },
    };
    const SLIDER_DEFS = {
      hideOpacityToValue: { flatMap: hideOpacityToValue, stepsMap: hideSequenceSteps, stepProp: 'opacityToValue' },
      hideOpacityByValue: { flatMap: hideOpacityByValue, stepsMap: hideSequenceSteps, stepProp: 'opacityByValue' },
    };
    const STEPS_MAP_BY_NAME = { hideSequenceSteps, recolorSequenceSteps, moveSequenceSteps };
    const DEFAULT_STEP_BY_KIND = { hide: defaultHideStep, recolor: defaultRecolorStep, move: defaultMoveStep };

    // Reads/writes a step-aware field: stepIndex -1 means the flat map,
    // otherwise def.stepsMap.get(key)[stepIndex][def.stepProp].
    function readStepAware(def, key, stepIndex, fallback) {
      if (stepIndex === -1) return getMapOr(def.flatMap, key, fallback);
      const step = (def.stepsMap.get(key) || [])[stepIndex];
      return step ? step[def.stepProp] : fallback;
    }
    function writeStepAware(def, key, stepIndex, value) {
      if (stepIndex === -1) { def.flatMap.set(key, value); return; }
      const steps = (def.stepsMap.get(key) || []).slice();
      if (!steps[stepIndex]) return;
      steps[stepIndex] = { ...steps[stepIndex], [def.stepProp]: value };
      def.stepsMap.set(key, steps);
    }

    // The shared "Trigger on:" picker (Break/Hide/Recolor/Move) - same
    // open/close-toggle-then-pick shape as Switch's own copy above.
    containerEl.querySelectorAll('[data-logic-trigger-toggle-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.logicTriggerToggleKey;
        const source = btn.dataset.logicTriggerToggleSource;
        const already = logicTriggerDropdownOpen && logicTriggerDropdownOpen.key === key && logicTriggerDropdownOpen.source === source;
        logicTriggerDropdownOpen = already ? null : { key, source };
        rerender();
      });
    });
    containerEl.querySelectorAll('[data-logic-trigger-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        logicTriggerModes.set(btn.dataset.logicTriggerKey, btn.dataset.logicTriggerMode);
        logicTriggerDropdownOpen = null;
        rerender();
      });
    });

    // The small 2-option field dropdowns (Hide's opacity to/by, Move's
    // action and to/by) - step-aware via readStepAware/writeStepAware.
    containerEl.querySelectorAll('[data-logic-field-toggle-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.logicFieldToggleKey;
        const source = btn.dataset.logicFieldToggleSource;
        const field = btn.dataset.logicFieldToggleField;
        const stepIndex = Number(btn.dataset.logicFieldToggleStep);
        const already = logicFieldDropdownOpen && logicFieldDropdownOpen.key === key && logicFieldDropdownOpen.source === source && logicFieldDropdownOpen.field === field && logicFieldDropdownOpen.stepIndex === stepIndex;
        logicFieldDropdownOpen = already ? null : { key, source, field, stepIndex };
        rerender();
      });
    });
    containerEl.querySelectorAll('[data-logic-field-value]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const def = FIELD_DEFS[btn.dataset.logicFieldField];
        if (def) writeStepAware(def, btn.dataset.logicFieldKey, Number(btn.dataset.logicFieldStep), btn.dataset.logicFieldValue);
        logicFieldDropdownOpen = null;
        window.BattleMap.requestRedraw();
        rerender();
      });
    });

    // The "+/-" sign buttons (Hide's opacity adjust direction, Move's
    // rotate adjust direction) - see renderSignButton's own comment.
    containerEl.querySelectorAll('.configure-sign-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const def = DIRECTION_DEFS[btn.dataset.directionMap];
        if (!def) return;
        const stepIndex = Number(btn.dataset.directionStep);
        const current = readStepAware(def, btn.dataset.directionKey, stepIndex, '-');
        writeStepAware(def, btn.dataset.directionKey, stepIndex, current === '+' ? '-' : '+');
        window.BattleMap.requestRedraw();
        rerender();
      });
    });

    // Move's x/y/z position fields - commits on blur/Enter, same
    // convention as the color hex input (no re-render while typing).
    containerEl.querySelectorAll('.configure-vector-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      const commit = () => {
        const def = VECTOR_MAP_DEFS[input.dataset.vectorMap];
        if (!def) return;
        const stepIndex = Number(input.dataset.vectorStep);
        const axis = input.dataset.vectorAxis;
        const num = Number(input.value);
        if (Number.isNaN(num)) { rerender(); return; }
        const current = readStepAware(def, input.dataset.vectorKey, stepIndex, { x: 0, y: 0, z: 0 }) || { x: 0, y: 0, z: 0 };
        if (current[axis] === num) return; // no actual change - don't push an undo step or re-render
        pushUndoSnapshot();
        writeStepAware(def, input.dataset.vectorKey, stepIndex, { ...current, [axis]: num });
        window.BattleMap.requestRedraw();
        rerender();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('blur', commit);
    });

    // Move's rotate buttons (New Rotation/Adjust) - the same 90°-
    // increment widget used for structures/textures, extended to also
    // reach a sequence step's own copy of the value via a composite
    // "stepsMapName:stepProp" rotateMap string (see renderRotateField).
    containerEl.querySelectorAll('.configure-rotate-btn[data-rotate-step]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const key = btn.dataset.rotateKey;
        const stepIndex = Number(btn.dataset.rotateStep);
        const rotateMap = btn.dataset.rotateMap;
        if (stepIndex === -1) {
          const flatMapsByName = { moveNewRotation, moveRotateAdjustStep };
          const map = flatMapsByName[rotateMap];
          if (!map) return;
          map.set(key, ((map.get(key) || 0) + 1) % 4);
        } else {
          const [stepsMapName, stepProp] = rotateMap.split(':');
          const stepsMap = STEPS_MAP_BY_NAME[stepsMapName];
          if (!stepsMap) return;
          const steps = (stepsMap.get(key) || []).slice();
          if (!steps[stepIndex]) return;
          steps[stepIndex] = { ...steps[stepIndex], [stepProp]: ((steps[stepIndex][stepProp] || 0) + 1) % 4 };
          stepsMap.set(key, steps);
        }
        window.BattleMap.requestRedraw();
        rerender();
      });
    });

    // Hide's opacity sliders - live-drag, one undo snapshot per whole
    // gesture (see rangeGestureSnapshotted's own comment), keeping the
    // typeable percentage field (below) in sync directly rather than
    // via a full re-render (which would tear down the slider mid-drag).
    containerEl.querySelectorAll('.configure-opacity-slider').forEach((el) => {
      const def = SLIDER_DEFS[el.dataset.sliderMap];
      if (!def) return;
      const stepIndex = Number(el.dataset.sliderStep);
      el.addEventListener('input', () => {
        if (!rangeGestureSnapshotted.has(el)) { pushUndoSnapshot(); rangeGestureSnapshotted.add(el); }
        writeStepAware(def, el.dataset.sliderKey, stepIndex, Number(el.value));
        window.BattleMap.requestRedraw();
        const row = el.closest('.configure-slider-row');
        const percentInput = row && row.querySelector('.configure-slider-percent-input');
        if (percentInput) percentInput.value = el.value;
      });
      el.addEventListener('change', () => { rangeGestureSnapshotted.delete(el); rerender(); });
    });

    // The opacity percentage field itself - typing a number commits on
    // blur/Enter, clamped to 0-100 (same convention as the vector
    // inputs above: no re-render while typing, commit only reacts to a
    // real change).
    containerEl.querySelectorAll('.configure-slider-percent-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      const commit = () => {
        const def = SLIDER_DEFS[input.dataset.percentMap];
        if (!def) return;
        const num = Number(input.value);
        if (Number.isNaN(num)) { rerender(); return; }
        const clamped = Math.max(0, Math.min(100, Math.round(num)));
        const stepIndex = Number(input.dataset.percentStep);
        const current = readStepAware(def, input.dataset.percentKey, stepIndex, 0);
        if (current === clamped) { input.value = clamped; return; }
        pushUndoSnapshot();
        writeStepAware(def, input.dataset.percentKey, stepIndex, clamped);
        window.BattleMap.requestRedraw();
        rerender();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
      input.addEventListener('blur', commit);
    });

    // Recolor's per-step color swatch - opens the same shared SV-
    // square-plus-sliders picker as the base (non-sequenced) case, just
    // targeting {stepsMapName,key,stepIndex} instead of {category,key,
    // which} (see getPickerTargetHex/setPickerTargetHex).
    containerEl.querySelectorAll('[data-step-color-picker-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = { key: btn.dataset.stepColorPickerKey, stepsMapName: btn.dataset.stepColorPickerStepsMap, stepIndex: Number(btn.dataset.stepColorPickerIndex), source: btn.dataset.stepColorPickerSource };
        const already = configureColorPickerOpen && configureColorPickerOpen.key === target.key && configureColorPickerOpen.stepsMapName === target.stepsMapName && configureColorPickerOpen.stepIndex === target.stepIndex && configureColorPickerOpen.source === target.source;
        if (!already) pushUndoSnapshot();
        configureColorPickerOpen = already ? null : target;
        configureColorDragContainer = containerEl;
        configureHexEditing = null;
        window.BattleMap.requestRedraw();
        rerender();
      });
    });
    containerEl.querySelectorAll('[data-step-hex-toggle-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        configureHexEditing = { key: btn.dataset.stepHexToggleKey, stepsMapName: btn.dataset.stepHexToggleStepsMap, stepIndex: Number(btn.dataset.stepHexToggleIndex), source: btn.dataset.stepHexToggleSource };
        configureColorPickerOpen = null;
        rerender();
        const input = containerEl.querySelector('.configure-step-color-hex-input');
        if (input) { input.focus(); input.select(); }
      });
    });
    containerEl.querySelectorAll('.configure-step-color-hex-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      const commit = () => {
        let val = input.value.trim();
        if (val && !val.startsWith('#')) val = '#' + val;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          pushUndoSnapshot();
          setPickerTargetHex({ key: input.dataset.stepHexKey, stepsMapName: input.dataset.stepHexStepsMap, stepIndex: Number(input.dataset.stepHexIndex) }, val.toLowerCase());
          window.BattleMap.requestRedraw();
        }
        configureHexEditing = null;
        rerender();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { configureHexEditing = null; rerender(); }
      });
      input.addEventListener('blur', commit);
    });

    // "Add Step +" - appends one default-valued step for whichever
    // piece this is (kind: 'hide' | 'recolor' | 'move').
    containerEl.querySelectorAll('.configure-add-step-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const stepsMap = STEPS_MAP_BY_NAME[btn.dataset.sequenceAddMap];
        const makeDefault = DEFAULT_STEP_BY_KIND[btn.dataset.sequenceAddKind];
        if (!stepsMap || !makeDefault) return;
        const key = btn.dataset.sequenceAddKey;
        stepsMap.set(key, [...(stepsMap.get(key) || []), makeDefault()]);
        rerender();
      });
    });
    // Removing one step - indices shift after a splice, same reasoning
    // as configureWireDropdownOpen getting cleared after a wire-remove
    // elsewhere in this file; no per-step dropdown state needs clearing
    // here since logicFieldDropdownOpen is keyed by {key,source,field,
    // stepIndex} and a stale stepIndex just won't match anything real
    // after the render that follows.
    containerEl.querySelectorAll('.configure-sequence-remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const stepsMap = STEPS_MAP_BY_NAME[btn.dataset.sequenceRemoveMap];
        if (!stepsMap) return;
        const key = btn.dataset.sequenceRemoveKey;
        const index = Number(btn.dataset.sequenceRemoveIndex);
        stepsMap.set(key, (stepsMap.get(key) || []).filter((_, i) => i !== index));
        logicFieldDropdownOpen = null;
        rerender();
      });
    });
  }

  function applyWireSVFromPointer(clientX, clientY) {
    const idKey = wireColorPickerOpen;
    const containerEl = wireColorDragContainer;
    const sq = containerEl && containerEl.querySelector('#wireSvSquare');
    if (!idKey || !sq) return;
    const rect = sq.getBoundingClientRect();
    const s = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    const v = Math.max(0, Math.min(100, 100 - ((clientY - rect.top) / rect.height) * 100));
    const hueSlider = containerEl.querySelector('#wireHueSlider');
    const h = hueSlider ? Number(hueSlider.value) : 0;
    applyWireHSV(idKey, h, s, v, containerEl);
  }
  function applyWireSliderInput(containerEl) {
    const idKey = wireColorPickerOpen;
    if (!idKey) return;
    const h = Number(containerEl.querySelector('#wireHueSlider').value);
    const s = Number(containerEl.querySelector('#wireSatSlider').value);
    const v = Number(containerEl.querySelector('#wireValSlider').value);
    applyWireHSV(idKey, h, s, v, containerEl);
  }
  function applyWireHSV(idKey, h, s, v, containerEl) {
    const hex = hsvToHex(h, s, v);
    setWireColorHex(idKey, hex);
    window.BattleMap.requestRedraw();
    updateWirePickerLive(h, s, v, hex, idKey, containerEl);
  }
  function updateWirePickerLive(h, s, v, hex, idKey, containerEl) {
    const sq = containerEl.querySelector('#wireSvSquare');
    if (sq) sq.style.setProperty('--sv-hue', h);
    const marker = containerEl.querySelector('#wireSvMarker');
    if (marker) { marker.style.left = s + '%'; marker.style.top = (100 - v) + '%'; }
    const hueSlider = containerEl.querySelector('#wireHueSlider');
    const satSlider = containerEl.querySelector('#wireSatSlider');
    const valSlider = containerEl.querySelector('#wireValSlider');
    if (hueSlider) hueSlider.value = h;
    if (satSlider) satSlider.value = s;
    if (valSlider) valSlider.value = v;
    if (hueSlider) hueSlider.style.setProperty('--track-gradient', 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)');
    if (satSlider) satSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, 0, v)}, ${hsvToHex(h, 100, v)})`);
    if (valSlider) valSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, s, 0)}, ${hsvToHex(h, s, 100)})`);
    const circleBtn = containerEl.querySelector(`.configure-color-circle-btn[data-wire-color-id="${idKey}"]`);
    if (circleBtn) circleBtn.style.background = hex;
    const hexBtn = containerEl.querySelector(`.configure-wire-hex-btn[data-wire-hex-id="${idKey}"]`);
    if (hexBtn) hexBtn.textContent = hex;
  }

  // The reverse of wallKey()/cellKey() - reconstructs a target shape
  // (configureTarget's own {edge} or {col,row} shape) from a stored
  // wire endpoint's key, so an already-committed wire's dropdown can
  // list items at ITS target location without needing that location
  // stored anywhere separately - the key already encodes it.
  function targetFromKey(key) {
    if (key.indexOf(':') !== -1) return { edge: parseWallKey(key) };
    const [col, row] = key.split(',').map(Number);
    return { col, row };
  }

  // Generic right-click context menu - shown at a fixed screen
  // position (standard context-menu behavior, no pan/zoom tracking),
  // closed by picking an item, clicking anywhere else, or explicitly
  // via hideMapContextMenu(). `items` is [{ label, disabled, onClick }] -
  // onClick fires with nothing else needed; the caller closures over
  // whatever state it needs. Not aware of Wire mode or anything else
  // that might use it later - see showWireContextMenuItems below for
  // the one consumer that exists today.
  function showMapContextMenu(clientX, clientY, items) {
    if (!mapContextMenuEl) return;
    mapContextMenu = { items };
    const viewportRect = mapContextMenuEl.parentElement.getBoundingClientRect();
    mapContextMenuEl.style.left = `${clientX - viewportRect.left}px`;
    mapContextMenuEl.style.top = `${clientY - viewportRect.top}px`;
    renderMapContextMenu();
  }
  function hideMapContextMenu() {
    mapContextMenu = null;
    renderMapContextMenu();
  }
  function renderMapContextMenu() {
    if (!mapContextMenuEl) return;
    if (!mapContextMenu) {
      mapContextMenuEl.innerHTML = '';
      mapContextMenuEl.classList.remove('visible');
      return;
    }
    mapContextMenuEl.innerHTML = mapContextMenu.items.length === 0
      ? '<div class="configure-trigger-empty">Nothing here.</div>'
      : mapContextMenu.items.map((it, i) => `
        <button class="header-dropdown-item" data-context-index="${i}" ${it.disabled ? 'disabled' : ''}>${it.label}</button>
      `).join('');
    mapContextMenuEl.classList.add('visible');
    mapContextMenuEl.querySelectorAll('[data-context-index]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const item = mapContextMenu.items[Number(btn.dataset.contextIndex)];
        hideMapContextMenu();
        if (item && item.onClick) item.onClick();
      });
    });
  }

  // Wire mode's use of the context menu above - right-click is now the
  // ONLY way the map itself offers an item picker (left-click just
  // does the same plain select-and-highlight Edit mode always did -
  // see handleMapClick). Same underlying gesture the sidebar's
  // "+"/"Connected to:" and the header's [ITEM] -> [ITEM] pair already
  // drive: picking a menu item either arms pendingWireSource (no
  // source yet) or commits the wire (one already pending).
  function showWireContextMenu(target, clientX, clientY) {
    const items = itemsAtTarget(target);
    const forDest = !!pendingWireSource;
    const options = forDest ? items.filter((it) => !sameWireEndpoint(it, pendingWireSource)) : items;
    const existingTargets = forDest
      ? new Set(wires.filter((w) => w.fromKey === pendingWireSource.key && w.fromCategory === pendingWireSource.category).map((w) => w.toKey + '|' + w.toCategory))
      : new Set();

    const menuItems = options.map((o) => ({
      label: wireEndpointFullLabel(o.key, o.category),
      disabled: existingTargets.has(o.key + '|' + o.category),
      onClick: () => {
        if (forDest) {
          pushUndoSnapshot();
          wires.push({
            fromKey: pendingWireSource.key,
            fromCategory: pendingWireSource.category,
            toKey: o.key,
            toCategory: o.category,
            color: wireDrawColor,
          });
          pendingWireSource = null;
          pendingWireDestTarget = null;
          configureWireDropdownOpen = null;
          headerWireSourceDropdownOpen = false;
          headerWireDestDropdownOpen = false;
        } else {
          pendingWireSource = { key: o.key, category: o.category };
          pendingWireDestTarget = null;
        }
        window.BattleMap.requestRedraw();
        renderDrawTab();
        renderHeaderLeft();
      },
    }));
    showMapContextMenu(clientX, clientY, menuItems);
  }

  // Header's own Edit-mode UI - a compact mirror of whatever the
  // sidebar's Configure panel is showing for configureTarget, so a DM
  // who doesn't want the sidebar open can still see and change
  // position/rotation/colors/settings for the selected item. This is
  // meant to be fully REDUNDANT with the sidebar (per the person's own
  // correction), not a replacement - both read/write the exact same
  // Maps, and every mutating handler here re-renders both surfaces
  // (renderDrawTab + renderHeaderLeft), same as the sidebar's own
  // wireConfigurePanel does.
  //
  // Item dropdown: dimmed/disabled until configureTarget has at least
  // one item; auto-focuses the sole item via getConfigureSelectedItem
  // when only one exists, otherwise reads "None" until the DM picks
  // one from the dropdown.
  function renderHeaderEditPickers() {
    const options = configureTarget ? itemsAtTarget(configureTarget) : [];
    const disabled = !configureTarget || options.length === 0;
    const item = getConfigureSelectedItem();
    const label = item ? `${item.category.charAt(0).toUpperCase() + item.category.slice(1)}: ${item.typeId.charAt(0).toUpperCase() + item.typeId.slice(1)}` : 'None';

    const dropdownHtml = configureItemDropdownOpen ? `
      <div class="header-dropdown configure-trigger-dropdown">
        ${options.length === 0 ? '<div class="configure-trigger-empty">Nothing here.</div>' : options.map((o) => `
          <button class="header-dropdown-item${item && item.key === o.key && item.category === o.category ? ' active' : ''}" data-header-item-key="${o.key}" data-header-item-category="${o.category}">
            ${o.category.charAt(0).toUpperCase() + o.category.slice(1)}: ${o.typeId.charAt(0).toUpperCase() + o.typeId.slice(1)}
          </button>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="header-selection-item">
        <button class="header-selection-btn configure-trigger-btn" id="configureItemSelectBtn" ${disabled ? 'disabled' : ''}>${label}<span class="header-caret">&#9662;</span></button>
        ${dropdownHtml}
      </div>
      ${item ? renderHeaderConfigureDetails(item) : ''}
    `;
  }

  // Switch's Settings content - "Trigger on:" plus whatever follows
  // from that choice. Shared between the sidebar's own Settings
  // subsection (always shown inline, per renderConfigureItem) and the
  // header's gear dropdown (shown only while configureSettingsDropdownOpen,
  // per renderHeaderConfigureSettingsDropdown) so the two can't drift
  // out of sync, same reasoning as every other Configure control that
  // appears in both places. `source` ('sidebar' | 'header') is only
  // used to key switchTriggerDropdownOpen, so opening this dropdown on
  // one surface doesn't affect the other's copy.
  //
  // Cosmetic only, per spec: this drives what the menu displays and
  // persists per-instance (undo-tracked, survives Arrange-move, reset
  // on delete/replace - see the switchTriggerModes/switchEveryTurn
  // declarations and their call sites), but nothing reads it to
  // actually fire anything yet - there's no Play mode to walk a wire
  // graph with yet, same status as every other Logic piece.
  //
  // Trigger on: Pulse (default) | Interact | Round Start | Turn Start.
  //   - Pulse: shows a "Pulse source:" row (a general item's pulse -
  //     nothing to wire it to yet, so it always reads "No wired source").
  //   - Interact: nothing further - the switch itself is the thing
  //     interacted with, same as Select tool's own Interact mode
  //     already does for lever/door.
  //   - Round Start: nothing further - fires globally, no source to pick.
  //   - Turn Start: shows an "Every Turn" toggle (default off). While
  //     off, shows its own "Pulse source:" row (a specific creature's
  //     turn this time, not a general item - still always "No wired
  //     source" until the creature layer and real wiring exist).
  function renderSwitchTriggerSettings(item, source) {
    const mode = switchTriggerModes.get(item.key) || 'pulse';
    const everyTurn = switchEveryTurn.get(item.key) || false;
    const modeLabel = (SWITCH_TRIGGER_OPTIONS.find((o) => o.id === mode) || SWITCH_TRIGGER_OPTIONS[0]).label;
    const isOpen = !!switchTriggerDropdownOpen && switchTriggerDropdownOpen.key === item.key && switchTriggerDropdownOpen.source === source;
    const showPulseSource = mode === 'pulse' || (mode === 'turnStart' && !everyTurn);

    const dropdownHtml = isOpen ? `
      <div class="header-dropdown configure-trigger-dropdown">
        ${SWITCH_TRIGGER_OPTIONS.map((o) => `
          <button class="header-dropdown-item${o.id === mode ? ' active' : ''}" data-switch-trigger-key="${item.key}" data-switch-trigger-mode="${o.id}" data-switch-trigger-source="${source}">${o.label}</button>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="configure-position-line configure-trigger-row">
        <span>Trigger on:</span>
        <div class="configure-trigger-wrap">
          <button class="header-selection-btn configure-trigger-btn" data-switch-trigger-toggle-key="${item.key}" data-switch-trigger-toggle-source="${source}">${modeLabel}<span class="header-caret">&#9662;</span></button>
          ${dropdownHtml}
        </div>
      </div>
      ${mode === 'turnStart' ? `
      <div class="configure-position-line configure-toggle-row">
        <span>Every Turn</span>
        <button class="configure-toggle-switch${everyTurn ? ' on' : ''}" data-toggle-key="${item.key}" data-toggle-map="switchEveryTurn" title="${everyTurn ? 'On' : 'Off'}">
          <span class="configure-toggle-thumb"></span>
        </button>
      </div>` : ''}
      ${showPulseSource ? `
      <div class="configure-position-line configure-trigger-row">
        <span>Pulse source:</span>
        <div class="configure-trigger-wrap">
          <button class="header-selection-btn configure-trigger-btn" disabled>No wired source</button>
        </div>
      </div>` : ''}
    `;
  }

  // ---------------------------------------------------------------
  // Break/Hide/Recolor/Move's Settings content - cosmetic-only, same
  // status as renderSwitchTriggerSettings above (persists per-instance,
  // undo-tracked, survives Arrange-move, resets on delete/replace -
  // see LOGIC_INSTANCE_MAPS - but nothing reads it to actually fire
  // anything yet). Shared between the sidebar's always-visible Settings
  // subsection and the header's gear dropdown via the same `source`
  // param convention as Switch's own block.
  //
  // A couple of small helpers first, since these four pieces share a
  // LOT of structure (the trigger block, plain yes/no toggles, small
  // 2-option pickers, and a "Sequence" system that turns one config
  // into a repeatable list of them) that Switch alone didn't need.
  // ---------------------------------------------------------------

  // has()-based reads everywhere below, rather than `map.get(key) ||
  // default` - several of these defaults are non-falsy (true, 50, '-')
  // so `||` would silently discard a legitimately-set value of 0/false.
  function getMapOr(map, key, def) {
    return map.has(key) ? map.get(key) : def;
  }

  // A "+/-" sign button (Hide's opacity-adjust direction, Move's
  // rotate-adjust direction) - a plain button showing the current sign
  // that flips it on click, rather than an on/off switch (a switch
  // implies a meaningful "off" state, which +/- doesn't have). Sits to
  // the immediate left of the control it modifies (the opacity slider,
  // the rotate button) - see wireLogicSettingsControls' DIRECTION_DEFS
  // for the write side.
  function renderSignButton(key, mapName, stepIndex, value) {
    return `<button class="configure-sign-btn" data-direction-key="${key}" data-direction-map="${mapName}" data-direction-step="${stepIndex}" title="Toggle +/-">${value}</button>`;
  }

  // Every Map the STEPS system (Add Step +/remove/per-step fields) can
  // read/write, keyed by the name used in a step's own composite
  // "stepsMapName" reference (renderRotateField's mapName, a step color
  // swatch's data-step-color-picker-steps-map, etc.) - one place so
  // both rendering and wiring agree on the mapping.
  function STEPS_MAPS() {
    return { hideSequenceSteps, recolorSequenceSteps, moveSequenceSteps };
  }

  // The shared color-picker system (configureColorPickerOpen/
  // configureHexEditing/applyConfigureHSV/etc.) was originally built
  // around a flat {category,key,which} target (wall/texture/structure/
  // Recolor's own single "Set Color"). A sequence step's own color
  // lives inside an array element instead, so a target can ALSO be
  // {stepsMapName,key,stepIndex} - these two functions are the one
  // place that branches on which shape it got, so every other picker
  // function (rendering, drag-apply, live-update) can stay shape-agnostic.
  function getPickerTargetHex(target) {
    if (target.stepsMapName) {
      const stepsMap = STEPS_MAPS()[target.stepsMapName];
      const step = (stepsMap.get(target.key) || [])[target.stepIndex];
      return (step && step.color) || DEFAULT_PRIMARY_COLOR;
    }
    const overrides = getItemColorOverride({ category: target.category, key: target.key });
    const defaults = defaultColorsFor({ category: target.category, key: target.key });
    return overrides[target.which] || defaults[target.which];
  }
  function setPickerTargetHex(target, hex) {
    if (target.stepsMapName) {
      const stepsMap = STEPS_MAPS()[target.stepsMapName];
      const steps = (stepsMap.get(target.key) || []).slice();
      if (!steps[target.stepIndex]) return;
      steps[target.stepIndex] = { ...steps[target.stepIndex], color: hex };
      stepsMap.set(target.key, steps);
      return;
    }
    setItemColorOverride({ category: target.category, key: target.key }, target.which, hex);
  }

  // Break/Hide/Recolor/Move's shared "Trigger on:" block - identical to
  // Switch's own except there's no Every Turn branch: Turn Start goes
  // straight to the Pulse source row here, per the spec.
  function renderLogicTriggerSettings(item, source) {
    const mode = getMapOr(logicTriggerModes, item.key, 'pulse');
    const modeLabel = (LOGIC_TRIGGER_OPTIONS.find((o) => o.id === mode) || LOGIC_TRIGGER_OPTIONS[0]).label;
    const isOpen = !!logicTriggerDropdownOpen && logicTriggerDropdownOpen.key === item.key && logicTriggerDropdownOpen.source === source;
    const showPulseSource = mode === 'pulse' || mode === 'turnStart';

    const dropdownHtml = isOpen ? `
      <div class="header-dropdown configure-trigger-dropdown">
        ${LOGIC_TRIGGER_OPTIONS.map((o) => `
          <button class="header-dropdown-item${o.id === mode ? ' active' : ''}" data-logic-trigger-key="${item.key}" data-logic-trigger-mode="${o.id}" data-logic-trigger-source="${source}">${o.label}</button>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="configure-position-line configure-trigger-row">
        <span>Trigger on:</span>
        <div class="configure-trigger-wrap">
          <button class="header-selection-btn configure-trigger-btn" data-logic-trigger-toggle-key="${item.key}" data-logic-trigger-toggle-source="${source}">${modeLabel}<span class="header-caret">&#9662;</span></button>
          ${dropdownHtml}
        </div>
      </div>
      ${showPulseSource ? `
      <div class="configure-position-line configure-trigger-row">
        <span>Pulse source:</span>
        <div class="configure-trigger-wrap">
          <button class="header-selection-btn configure-trigger-btn" disabled>No wired source</button>
        </div>
      </div>` : ''}
    `;
  }

  // A generic yes/no row - same visual/behavior as Switch's Every Turn
  // toggle, but parameterized so every plain boolean setting below
  // (Break warning, Sequence, Return on retrigger, Return on loop) can
  // share one render path. `isDefaultOn` is baked into
  // data-toggle-default so the click handler (wireConfigurePanel/
  // wireHeaderConfigureDetails) knows what "currently off" means for a
  // map that's never been explicitly set - see those handlers.
  function renderToggleRow(label, key, mapName, isOn, isDefaultOn) {
    return `
      <div class="configure-position-line configure-toggle-row">
        <span>${label}</span>
        <button class="configure-toggle-switch${isOn ? ' on' : ''}" data-toggle-key="${key}" data-toggle-map="${mapName}" data-toggle-default="${isDefaultOn ? 'true' : 'false'}" title="${isOn ? 'On' : 'Off'}">
          <span class="configure-toggle-thumb"></span>
        </button>
      </div>
    `;
  }

  // A generic small options dropdown (Hide's opacity To/By, Move's
  // Move/Rotate and To/By) - `field` names which one (see FIELD_DEFS
  // below), `stepIndex` is -1 for the single non-sequenced config or a
  // sequence step's array index, letting a step's own copy of a
  // dropdown open independently of the base config's copy (and of any
  // other step's copy) - see logicFieldDropdownOpen's own comment.
  function renderFieldDropdown(key, source, field, stepIndex, options, currentId) {
    const currentLabel = (options.find((o) => o.id === currentId) || options[0]).label;
    const isOpen = !!logicFieldDropdownOpen && logicFieldDropdownOpen.key === key && logicFieldDropdownOpen.source === source && logicFieldDropdownOpen.field === field && logicFieldDropdownOpen.stepIndex === stepIndex;
    const dropdownHtml = isOpen ? `
      <div class="header-dropdown configure-trigger-dropdown">
        ${options.map((o) => `
          <button class="header-dropdown-item${o.id === currentId ? ' active' : ''}" data-logic-field-key="${key}" data-logic-field-source="${source}" data-logic-field-field="${field}" data-logic-field-step="${stepIndex}" data-logic-field-value="${o.id}">${o.label}</button>
        `).join('')}
      </div>
    ` : '';
    return `
      <div class="configure-trigger-wrap configure-field-dropdown-wrap">
        <button class="header-selection-btn configure-trigger-btn" data-logic-field-toggle-key="${key}" data-logic-field-toggle-source="${source}" data-logic-field-toggle-field="${field}" data-logic-field-toggle-step="${stepIndex}">${currentLabel}<span class="header-caret">&#9662;</span></button>
        ${dropdownHtml}
      </div>
    `;
  }

  // field name -> where its value actually lives, for both the flat
  // (stepIndex -1) case and inside a sequence step. Shared by every
  // renderFieldDropdown call site and by wireConfigurePanel/
  // wireHeaderConfigureDetails' one generic click handler for all of
  // them, so adding a new small dropdown means adding one entry here
  // rather than a new bespoke handler.
  function FIELD_DEFS() {
    return {
      opacityMode: { flatMap: hideOpacityMode, stepsMap: hideSequenceSteps, stepProp: 'opacityMode' },
      moveAction: { flatMap: moveAction, stepsMap: moveSequenceSteps, stepProp: 'action' },
      moveMode: { flatMap: moveMode, stepsMap: moveSequenceSteps, stepProp: 'mode' },
    };
  }

  // A plain numeric x/y/z row (Move's "New Position"/"Adjust") - commits
  // on blur/Enter, same convention as the color hex input, rather than
  // re-rendering on every keystroke.
  // The dash-wrapped labels in the person's own spec ("-New Position-",
  // "-Adjust Opacity-", etc.) are meant to read as the same small/light
  // sub-label style already used for "Positioning"/"Settings" -
  // reusing .configure-subsection-label directly rather than inventing
  // a near-duplicate class.
  function renderVectorRow(item, source, mapName, stepIndex, vec, label) {
    const axes = ['x', 'y', 'z'];
    return `
      <div class="configure-position-line configure-vector-row">
        <span class="configure-subsection-label">${label}</span>
        <div class="configure-vector-fields">
          ${axes.map((axis) => `
            <label class="configure-vector-field">${axis}: <input type="number" class="configure-vector-input" data-vector-key="${item.key}" data-vector-map="${mapName}" data-vector-step="${stepIndex}" data-vector-axis="${axis}" value="${vec[axis]}"></label>
          `).join('')}
        </div>
      </div>
    `;
  }

  const VECTOR_DEFS = {
    moveNewPosition: { flatMap: moveNewPosition, stepsMap: moveSequenceSteps, stepProp: 'newPosition' },
    moveAdjust: { flatMap: moveAdjust, stepsMap: moveSequenceSteps, stepProp: 'adjust' },
  };

  // A 90°-increment rotate control (Move's "New Rotation"/"Adjust"
  // rotation) - the exact same widget used everywhere else in Configure
  // for structures/textures (see the person's explicit direction: "the
  // usual one... adds 90deg... no way to type a rotation"). Reuses the
  // existing .configure-rotate-btn CSS/RESET_ICON; only the wiring
  // (below) needs to know how to reach a sequence step's own copy.
  // `signButtonHtml` is the +/- button (see renderSignButton) for the
  // rotate-by case, rendered immediately to the rotate button's left -
  // grouped into one .configure-rotation-controls wrapper together with
  // the degree readout so the row's own space-between (label vs.
  // everything else) still only ever sees two children.
  function renderRotateField(item, mapName, stepIndex, quarterTurns, label, signButtonHtml) {
    return `
      <div class="configure-position-line configure-rotation-line">
        <div class="configure-rotation-label-stack">
          <span class="configure-subsection-label">${label}</span>
          <span class="configure-rotation-value">${quarterTurns * 90}&deg;</span>
        </div>
        <div class="configure-rotation-controls">
          ${signButtonHtml || ''}
          <button class="configure-rotate-btn" data-rotate-key="${item.key}" data-rotate-map="${mapName}" data-rotate-step="${stepIndex}" title="Rotate 90°">${RESET_ICON}</button>
        </div>
      </div>
    `;
  }

  function defaultHideStep() {
    return { opacityMode: 'to', opacityToValue: 0, opacityByDirection: '-', opacityByValue: 50 };
  }
  function defaultRecolorStep() {
    return { color: DEFAULT_PRIMARY_COLOR };
  }
  function defaultMoveStep() {
    return { action: 'move', mode: 'to', newPosition: { x: 0, y: 0, z: 0 }, adjust: { x: 0, y: 0, z: 0 }, newRotation: 0, rotateAdjustDirection: '+', rotateAdjustStep: 0 };
  }

  // --- Break --------------------------------------------------------
  // Simplest of the four - just the shared trigger block plus a single
  // warning toggle, no Sequence system at all.
  function renderBreakSettings(item, source) {
    const warning = getMapOr(breakWarning, item.key, true);
    return `
      ${renderLogicTriggerSettings(item, source)}
      ${renderToggleRow('Break warning', item.key, 'breakWarning', warning, true)}
    `;
  }

  // --- Hide -----------------------------------------------------------
  // The opacity change itself (to/by) plus its own Return on retrigger
  // when not sequenced, or a repeatable list of the same when it is.
  function renderHideOpacityFields(item, source, stepIndex) {
    const isFlat = stepIndex === -1;
    const step = isFlat ? null : ((hideSequenceSteps.get(item.key) || [])[stepIndex] || defaultHideStep());
    const mode = isFlat ? getMapOr(hideOpacityMode, item.key, 'to') : step.opacityMode;
    const toValue = isFlat ? getMapOr(hideOpacityToValue, item.key, 0) : step.opacityToValue;
    const byDirection = isFlat ? getMapOr(hideOpacityByDirection, item.key, '-') : step.opacityByDirection;
    const byValue = isFlat ? getMapOr(hideOpacityByValue, item.key, 50) : step.opacityByValue;
    const sliderMap = mode === 'to' ? 'hideOpacityToValue' : 'hideOpacityByValue';
    const sliderValue = mode === 'to' ? toValue : byValue;
    const sliderLabel = mode === 'to' ? 'Set Opacity' : 'Adjust Opacity';

    return `
      <div class="configure-position-line configure-trigger-row">
        <span>Change opacity:</span>
        ${renderFieldDropdown(item.key, source, 'opacityMode', stepIndex, TO_BY_OPTIONS, mode)}
      </div>
      <div class="configure-position-line configure-slider-row">
        <div class="configure-slider-label-row">
          <span class="configure-subsection-label">${sliderLabel}</span>
          <span class="configure-slider-value-wrap">
            <input type="text" inputmode="numeric" class="configure-slider-percent-input" data-percent-key="${item.key}" data-percent-map="${sliderMap}" data-percent-step="${stepIndex}" value="${sliderValue}">%
          </span>
        </div>
        <div class="configure-slider-with-sign">
          ${mode === 'by' ? renderSignButton(item.key, 'hideOpacityByDirection', stepIndex, byDirection) : ''}
          <input type="range" class="configure-opacity-slider" min="0" max="100" value="${sliderValue}" data-slider-key="${item.key}" data-slider-map="${sliderMap}" data-slider-step="${stepIndex}">
        </div>
      </div>
    `;
  }

  function renderHideSettings(item, source) {
    const sequence = getMapOr(hideSequence, item.key, false);
    const steps = hideSequenceSteps.get(item.key) || [];
    const mode = getMapOr(hideOpacityMode, item.key, 'to');
    const returnDefault = mode === 'to';
    const returnOnRetrigger = getMapOr(hideReturnOnRetrigger, item.key, returnDefault);
    const returnOnLoop = getMapOr(hideReturnOnLoop, item.key, true);

    return `
      ${renderLogicTriggerSettings(item, source)}
      ${renderToggleRow('Sequence', item.key, 'hideSequence', sequence, false)}
      ${!sequence ? `
        ${renderHideOpacityFields(item, source, -1)}
        ${renderToggleRow('Return on retrigger', item.key, 'hideReturnOnRetrigger', returnOnRetrigger, returnDefault)}
      ` : `
        ${steps.map((s, i) => `
          <div class="configure-sequence-step">
            <div class="configure-position-line configure-sequence-step-header">
              <span>Step ${i + 1}</span>
              <button class="configure-sequence-remove-btn" data-sequence-remove-key="${item.key}" data-sequence-remove-map="hideSequenceSteps" data-sequence-remove-index="${i}" title="Remove step">&times;</button>
            </div>
            ${renderHideOpacityFields(item, source, i)}
          </div>
        `).join('')}
        <button class="configure-add-step-btn" data-sequence-add-key="${item.key}" data-sequence-add-map="hideSequenceSteps" data-sequence-add-kind="hide">Add Step +</button>
        ${renderToggleRow('Return on loop', item.key, 'hideReturnOnLoop', returnOnLoop, true)}
      `}
    `;
  }

  // --- Recolor --------------------------------------------------------
  function renderRecolorColorField(item, source, stepIndex) {
    if (stepIndex === -1) {
      // Reuses the exact same color-chip/hex/reset/picker UI as wall/
      // texture/structure - colorMapFor treats category 'logic' as
      // recolorColors (see that function), so this needs no bespoke
      // picker code of its own. `source` is passed through (rather than
      // always assuming 'sidebar') since Recolor's own Settings body is
      // the one place this row layout is used from both surfaces - see
      // renderConfigureColorRow's own comment.
      return renderConfigureColorRow(item, 'primary', 'Set Color', source);
    }
    // A sequence step's own color - same circular-swatch-opens-the-
    // full-picker experience as the flat case above, just backed by
    // getPickerTargetHex/setPickerTargetHex's {stepsMapName,key,
    // stepIndex} target shape instead of {category,key,which}, since
    // the color lives inside an array element rather than a flat Map.
    const hex = getPickerTargetHex({ stepsMapName: 'recolorSequenceSteps', key: item.key, stepIndex });
    const isPickerOpen = !!(configureColorPickerOpen && configureColorPickerOpen.source === source && configureColorPickerOpen.stepsMapName === 'recolorSequenceSteps' && configureColorPickerOpen.key === item.key && configureColorPickerOpen.stepIndex === stepIndex);
    const isHexEditing = !!(configureHexEditing && configureHexEditing.source === source && configureHexEditing.stepsMapName === 'recolorSequenceSteps' && configureHexEditing.key === item.key && configureHexEditing.stepIndex === stepIndex);
    return `
      <div class="configure-color-row">
        <span class="configure-color-label settings-row-label">Color:</span>
        <div class="configure-color-chip">
          <button class="configure-step-color-swatch" style="background:${hex}" data-step-color-picker-key="${item.key}" data-step-color-picker-steps-map="recolorSequenceSteps" data-step-color-picker-index="${stepIndex}" data-step-color-picker-source="${source}" title="Choose color"></button>
          ${isHexEditing
            ? `<input type="text" class="configure-step-color-hex-input" data-step-hex-key="${item.key}" data-step-hex-steps-map="recolorSequenceSteps" data-step-hex-index="${stepIndex}" data-step-hex-source="${source}" value="${hex}" maxlength="7" spellcheck="false">`
            : `<button class="configure-step-color-hex-btn" data-step-hex-toggle-key="${item.key}" data-step-hex-toggle-steps-map="recolorSequenceSteps" data-step-hex-toggle-index="${stepIndex}" data-step-hex-toggle-source="${source}">${hex}</button>`}
        </div>
        ${isPickerOpen ? renderConfigureColorPicker(hex) : ''}
      </div>
    `;
  }

  function renderRecolorSettings(item, source) {
    const sequence = getMapOr(recolorSequence, item.key, false);
    const steps = recolorSequenceSteps.get(item.key) || [];
    const returnOnRetrigger = getMapOr(recolorReturnOnRetrigger, item.key, true);
    const returnOnLoop = getMapOr(recolorReturnOnLoop, item.key, true);

    return `
      ${renderLogicTriggerSettings(item, source)}
      ${renderToggleRow('Sequence', item.key, 'recolorSequence', sequence, false)}
      ${!sequence ? `
        ${renderRecolorColorField(item, source, -1)}
        ${renderToggleRow('Return on retrigger', item.key, 'recolorReturnOnRetrigger', returnOnRetrigger, true)}
      ` : `
        ${steps.map((s, i) => `
          <div class="configure-sequence-step">
            <div class="configure-position-line configure-sequence-step-header">
              <span>Step ${i + 1}</span>
              <button class="configure-sequence-remove-btn" data-sequence-remove-key="${item.key}" data-sequence-remove-map="recolorSequenceSteps" data-sequence-remove-index="${i}" title="Remove step">&times;</button>
            </div>
            ${renderRecolorColorField(item, source, i)}
          </div>
        `).join('')}
        <button class="configure-add-step-btn" data-sequence-add-key="${item.key}" data-sequence-add-map="recolorSequenceSteps" data-sequence-add-kind="recolor">Add Step +</button>
        ${renderToggleRow('Return on loop', item.key, 'recolorReturnOnLoop', returnOnLoop, true)}
      `}
    `;
  }

  // --- Move -------------------------------------------------------
  function renderMoveActionFields(item, source, stepIndex) {
    const isFlat = stepIndex === -1;
    const step = isFlat ? null : ((moveSequenceSteps.get(item.key) || [])[stepIndex] || defaultMoveStep());
    const action = isFlat ? getMapOr(moveAction, item.key, 'move') : step.action;
    const mode = isFlat ? getMapOr(moveMode, item.key, 'to') : step.mode;
    const newPosition = isFlat ? getMapOr(moveNewPosition, item.key, { x: 0, y: 0, z: 0 }) : step.newPosition;
    const adjust = isFlat ? getMapOr(moveAdjust, item.key, { x: 0, y: 0, z: 0 }) : step.adjust;
    const newRotation = isFlat ? getMapOr(moveNewRotation, item.key, 0) : step.newRotation;
    const rotateAdjustDirection = isFlat ? getMapOr(moveRotateAdjustDirection, item.key, '+') : step.rotateAdjustDirection;
    const rotateAdjustStep = isFlat ? getMapOr(moveRotateAdjustStep, item.key, 0) : step.rotateAdjustStep;

    // Action's two dropdowns read as one sentence ("Action: Move To") -
    // grouped into a single tightly-packed, right-aligned wrapper so
    // the row's own space-between (label vs. everything else) only
    // ever sees two children, same reasoning as renderRotateField's
    // .configure-rotation-controls grouping above.
    return `
      <div class="configure-position-line configure-trigger-row">
        <span>Change:</span>
        <div class="configure-move-action-group">
          ${renderFieldDropdown(item.key, source, 'moveAction', stepIndex, MOVE_ACTION_OPTIONS, action)}
          ${renderFieldDropdown(item.key, source, 'moveMode', stepIndex, TO_BY_OPTIONS, mode)}
        </div>
      </div>
      ${action === 'move' && mode === 'to' ? renderVectorRow(item, source, 'moveNewPosition', stepIndex, newPosition, 'New Position') : ''}
      ${action === 'move' && mode === 'by' ? renderVectorRow(item, source, 'moveAdjust', stepIndex, adjust, 'Adjust Position') : ''}
      ${action === 'rotate' && mode === 'to' ? renderRotateField(item, stepIndex === -1 ? 'moveNewRotation' : 'moveSequenceSteps:newRotation', stepIndex, newRotation, 'New Rotation') : ''}
      ${action === 'rotate' && mode === 'by' ? renderRotateField(item, stepIndex === -1 ? 'moveRotateAdjustStep' : 'moveSequenceSteps:rotateAdjustStep', stepIndex, rotateAdjustStep, 'Adjust Rotation', renderSignButton(item.key, 'moveRotateAdjustDirection', stepIndex, rotateAdjustDirection)) : ''}
    `;
  }

  function renderMoveSettings(item, source) {
    const sequence = getMapOr(moveSequence, item.key, false);
    const steps = moveSequenceSteps.get(item.key) || [];
    const mode = getMapOr(moveMode, item.key, 'to');
    const returnDefault = mode === 'to';
    const returnOnRetrigger = getMapOr(moveReturnOnRetrigger, item.key, returnDefault);
    const returnOnLoop = getMapOr(moveReturnOnLoop, item.key, true);

    return `
      ${renderLogicTriggerSettings(item, source)}
      ${renderToggleRow('Sequence', item.key, 'moveSequence', sequence, false)}
      ${!sequence ? `
        ${renderMoveActionFields(item, source, -1)}
        ${renderToggleRow('Return on retrigger', item.key, 'moveReturnOnRetrigger', returnOnRetrigger, returnDefault)}
      ` : `
        ${steps.map((s, i) => `
          <div class="configure-sequence-step">
            <div class="configure-position-line configure-sequence-step-header">
              <span>Step ${i + 1}</span>
              <button class="configure-sequence-remove-btn" data-sequence-remove-key="${item.key}" data-sequence-remove-map="moveSequenceSteps" data-sequence-remove-index="${i}" title="Remove step">&times;</button>
            </div>
            ${renderMoveActionFields(item, source, i)}
          </div>
        `).join('')}
        <button class="configure-add-step-btn" data-sequence-add-key="${item.key}" data-sequence-add-map="moveSequenceSteps" data-sequence-add-kind="move">Add Step +</button>
        ${renderToggleRow('Return on loop', item.key, 'moveReturnOnLoop', returnOnLoop, true)}
      `}
    `;
  }

  // One dispatcher covering all four - renderConfigureItem/
  // renderHeaderConfigureDetails just need to know "is this one of the
  // four" (LOGIC_SETTINGS_RENDERERS having an entry) rather than a long
  // if/else chain at each of those two call sites.
  const LOGIC_SETTINGS_RENDERERS = {
    break: renderBreakSettings,
    hide: renderHideSettings,
    recolor: renderRecolorSettings,
    move: renderMoveSettings,
  };

  // The positioning/rotation/color/settings cluster shown once the
  // header's own item dropdown resolves to something - X/Z (see
  // renderConfigureItem's own comment on why Y is always 0 for now)
  // above the rotation line, then the rotate button, then primary/
  // secondary color boxes (styled like the Paint tool's own header
  // swatches, per the person's explicit direction) each with its own
  // reset button, then a swap button, then the Settings gear.
  function renderHeaderConfigureDetails(item) {
    const hasRotation = item.category === 'structure' || item.category === 'texture';
    const showRotationLine = item.category !== 'logic';
    const rotation = hasRotation ? (rotationMapFor(item).get(item.key) || 0) : 0;

    let posX, posZ;
    if (item.key.indexOf(':') !== -1) {
      const edge = parseWallKey(item.key);
      posX = edge.col; posZ = edge.row;
    } else {
      const [c, r] = item.key.split(',').map(Number);
      posX = c; posZ = r;
    }

    const hasColors = item.category !== 'logic';
    const hasSecondary = item.category !== 'wall';

    let toggle = null;
    if (item.typeId === 'lever') {
      toggle = { map: 'leverOnStates', label: 'Off/On', isOn: leverOnStates.get(item.key) || false };
    } else if (item.typeId === 'door') {
      toggle = { map: 'doorOpenStates', label: 'Closed/Open', isOn: doorOpenStates.get(item.key) || false };
    }
    const isSwitch = item.typeId === 'switch';
    const logicRenderer = LOGIC_SETTINGS_RENDERERS[item.typeId];
    const hasSettings = !!toggle || isSwitch || !!logicRenderer;

    return `
      <div class="header-position-block">
        <span class="header-position-line">X: ${posX} &nbsp; Z: ${posZ}</span>
        ${showRotationLine ? `
        <div class="header-position-line header-configure-details configure-rotation-line">
          <span>Rotation: ${rotation * 90}&deg;</span>
          ${hasRotation ? `<button class="configure-rotate-btn" data-rotate-key="${item.key}" data-rotate-map="${item.typeId === 'door' ? 'doors' : item.category === 'texture' ? 'textureRotations' : 'structureRotations'}" title="Rotate 90°">${RESET_ICON}</button>` : ''}
        </div>` : ''}
      </div>
      ${hasColors ? `
      <div class="header-color-reset-stack">
        <div class="header-color-box-wrap">
          ${renderHeaderConfigureColorBox(item, 'primary')}
        </div>
        ${renderHeaderConfigureResetBtn(item, 'primary')}
        ${hasSecondary ? `
        <div class="header-color-box-wrap">
          ${renderHeaderConfigureColorBox(item, 'secondary')}
        </div>
        ${renderHeaderConfigureResetBtn(item, 'secondary')}` : ''}
        ${hasSecondary ? `<button class="header-icon-square-btn header-swap-btn" id="configureSwapColorsBtn" data-swap-key="${item.key}" data-swap-category="${item.category}" title="Swap primary and secondary">${SWAP_ICON}</button>` : ''}
      </div>` : ''}
      ${renderHeaderConfigureSettingsDropdown(item, toggle, hasSettings, isSwitch, logicRenderer)}
    `;
  }

  // A header-side color swatch button - same look/behavior as the
  // Paint tool's own header-color-box, but reading/writing the
  // selected item's color override instead of the global paint color.
  // Only renders ITS OWN copy of the SV-square picker when
  // configureColorPickerOpen.source is 'header' (see that state's own
  // comment) - the sidebar's matching renderConfigureColorRow does the
  // mirror check for 'sidebar', so exactly one copy of the (shared,
  // fixed-id) picker markup ever exists in the DOM at once.
  function renderHeaderConfigureColorBox(item, which) {
    const overrides = getItemColorOverride(item);
    const defaults = defaultColorsFor(item);
    const hex = overrides[which] || defaults[which];
    const isPickerOpen = !!(configureColorPickerOpen && configureColorPickerOpen.source === 'header' && configureColorPickerOpen.key === item.key && configureColorPickerOpen.category === item.category && configureColorPickerOpen.which === which);
    return `
      <button class="header-color-box" data-header-color-key="${item.key}" data-header-color-which="${which}" data-header-color-category="${item.category}" style="background:${hex}" title="${which === 'primary' ? 'Primary' : 'Secondary'} color"></button>
      ${isPickerOpen ? renderConfigureColorPicker(hex) : ''}
    `;
  }

  function renderHeaderConfigureResetBtn(item, which) {
    const overrides = getItemColorOverride(item);
    const isManual = !!overrides[which];
    return `<button class="header-icon-square-btn" data-header-reset-key="${item.key}" data-header-reset-which="${which}" data-header-reset-category="${item.category}" title="Reset to default" ${isManual ? '' : 'disabled'}>${RESET_ICON}</button>`;
  }

  // The header's gear/Settings button - dimmed when the selected item
  // has no settings of its own (nothing to configure yet), otherwise
  // opens a small dropdown holding the same toggle row the sidebar
  // shows under its own "Settings" subsection.
  function renderHeaderConfigureSettingsDropdown(item, toggle, hasSettings, isSwitch, logicRenderer) {
    const dropdownHtml = (configureSettingsDropdownOpen && hasSettings) ? `
      <div class="header-dropdown configure-trigger-dropdown configure-settings-dropdown">
        ${isSwitch ? renderSwitchTriggerSettings(item, 'header') : logicRenderer ? logicRenderer(item, 'header') : toggle ? `
        <div class="configure-position-line configure-toggle-row">
          <span>${toggle.label}</span>
          <button class="configure-toggle-switch${toggle.isOn ? ' on' : ''}" data-toggle-key="${item.key}" data-toggle-map="${toggle.map}" title="${toggle.isOn ? 'On' : 'Off'}">
            <span class="configure-toggle-thumb"></span>
          </button>
        </div>` : '<div class="configure-trigger-empty">Nothing to configure yet.</div>'}
      </div>
    ` : '';
    return `
      <div class="header-color-box-wrap">
        <button class="header-icon-square-btn" id="configureSettingsBtn" title="Settings" ${hasSettings ? '' : 'disabled'}>${GEAR_ICON}</button>
        ${dropdownHtml}
      </div>
    `;
  }

  // Header's own Wire-mode UI - the "[ITEM] -> [ITEM]" pair. A second
  // surface for exactly the gesture the sidebar's "+"/"Connected to:"
  // flow already drives (same pendingWireSource/pendingWireDestTarget
  // state, same commit logic) - its purpose is letting the DM pick or
  // CHANGE the source without the sidebar open, which the sidebar's
  // one-shot "+" doesn't allow (clicking a different item's "+" there
  // restarts the pending wire fresh, but there's no "still pending,
  // just point it at a different item here instead" - this dropdown
  // covers that by staying open/live on the source the whole time).
  // Both boxes dim (native disabled) until there's something to choose
  // from - the source box needs a selected location, the destination
  // box needs pendingWireDestTarget to exist.
  function renderHeaderWirePickers() {
    const sourceOptions = configureTarget ? itemsAtTarget(configureTarget) : [];
    const sourceDisabled = !configureTarget || sourceOptions.length === 0;
    const sourceLabel = pendingWireSource ? wireEndpointLabel(pendingWireSource.key, pendingWireSource.category) : 'None';

    const destDisabled = !pendingWireDestTarget;
    const destOptions = pendingWireDestTarget
      ? itemsAtTarget(pendingWireDestTarget).filter((it) => !sameWireEndpoint(it, pendingWireSource))
      : [];
    const existingTargets = pendingWireSource
      ? new Set(wires.filter((w) => w.fromKey === pendingWireSource.key && w.fromCategory === pendingWireSource.category).map((w) => w.toKey + '|' + w.toCategory))
      : new Set();

    const sourceDropdownHtml = headerWireSourceDropdownOpen ? `
      <div class="header-dropdown configure-trigger-dropdown">
        ${sourceOptions.map((o) => `
          <button class="header-dropdown-item${pendingWireSource && sameWireEndpoint(o, pendingWireSource) ? ' active' : ''}" data-header-wire-source-key="${o.key}" data-header-wire-source-category="${o.category}">
            ${wireEndpointFullLabel(o.key, o.category)}
          </button>
        `).join('')}
      </div>
    ` : '';
    const destDropdownHtml = headerWireDestDropdownOpen ? `
      <div class="header-dropdown configure-trigger-dropdown">
        ${destOptions.length === 0 ? '<div class="configure-trigger-empty">Nothing else here.</div>' : destOptions.map((o) => `
          <button class="header-dropdown-item" data-header-wire-target-key="${o.key}" data-header-wire-target-category="${o.category}" ${existingTargets.has(o.key + '|' + o.category) ? 'disabled' : ''}>
            ${wireEndpointFullLabel(o.key, o.category)}
          </button>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="header-wire-picker-group">
        <div class="header-selection-item">
          <button class="header-selection-btn header-wire-picker-btn" id="headerWireSourceBtn" ${sourceDisabled ? 'disabled' : ''}>${sourceLabel}<span class="header-caret">&#9662;</span></button>
          ${sourceDropdownHtml}
        </div>
        <span class="header-wire-arrow">&rarr;</span>
        <div class="header-selection-item">
          <button class="header-selection-btn header-wire-picker-btn" id="headerWireDestBtn" ${destDisabled ? 'disabled' : ''}>None<span class="header-caret">&#9662;</span></button>
          ${destDropdownHtml}
        </div>
      </div>
      ${renderWireColorRow(wireDrawColor, 'pending')}
    `;
  }


  // Wire mode's own item list - unlike Edit mode, configureTarget
  // deliberately never moves while a wire is being built (see
  // handleMapClick's configure branch) - the sidebar stays fixed on
  // the source's own location for the whole gesture, so there's no
  // "detached row" concept to handle here the way there used to be.
  function renderWirePanel(header) {
    if (!configureTarget) {
      return `${header}<p class="menu-placeholder">No tile or line selected.</p>`;
    }
    const currentItems = itemsAtTarget(configureTarget);
    if (currentItems.length === 0) {
      return `${header}<p class="menu-placeholder">Nothing here.</p>`;
    }
    const rows = currentItems.map((item) => renderWireItemRow(item)).join('');
    return `${header}<div class="configure-item-list">${rows}</div>`;
  }

  function renderWireItemRow(item) {
    const type = findType(item.category, item.typeId);
    const preview = type ? previewForType(item.category, type) : '';
    const categoryLabel = item.category.charAt(0).toUpperCase() + item.category.slice(1);
    const nameLabel = item.typeId.charAt(0).toUpperCase() + item.typeId.slice(1);
    const isPending = sameWireEndpoint(item, pendingWireSource);

    // Wires FROM this item specifically - used only for the pending
    // row's own duplicate-destination check below (a NEW wire being
    // built from this exact item shouldn't offer a destination it
    // already has one going to). The connection rows themselves use
    // the broader relevantWires below instead.
    const fromWires = wires
      .map((w, idx) => ({ w, idx }))
      .filter(({ w }) => w.fromKey === item.key && w.fromCategory === item.category);

    // Every wire touching this item at all - as either its source OR
    // its destination - shows up in its section, always labeled
    // "[Source] -> [Input]" in that same fixed order regardless of
    // which end THIS item happens to be. A receiving item's own
    // section previously showed nothing for wires coming into it;
    // this is what surfaces those too. Order follows `wires` itself
    // (insertion order - new wires are always pushed to the end), so
    // this never re-sorts by role - it's always "the order it was
    // wired in", the same order every other surface already uses.
    const relevantWires = wires
      .map((w, idx) => ({ w, idx }))
      .filter(({ w }) => (w.fromKey === item.key && w.fromCategory === item.category) || (w.toKey === item.key && w.toCategory === item.category));

    // Every already-committed wire shows BOTH endpoints as their own
    // live dropdown, "[Source] -> [Input]" - reopening either one
    // lists items at THAT endpoint's own location (targetFromKey),
    // never wherever configureTarget happens to be, so repointing
    // either side never requires deleting and recreating the wire.
    // Changing the source doesn't need any special "move" logic here -
    // this function is only ever called per-item, filtering wires by
    // fromKey/fromCategory fresh each render, so a wire whose source
    // just changed simply stops matching THIS item's filter and starts
    // matching the new source's instead the next time the panel
    // renders - the "section" it appears under moves for free.
    const connectionRows = relevantWires.map(({ w, idx }) => {
      const sourceOpen = !!configureWireDropdownOpen && configureWireDropdownOpen.index === idx && configureWireDropdownOpen.side === 'source';
      const destOpen = !!configureWireDropdownOpen && configureWireDropdownOpen.index === idx && configureWireDropdownOpen.side === 'dest';
      const sourceItems = itemsAtTarget(targetFromKey(w.fromKey));
      const destItems = itemsAtTarget(targetFromKey(w.toKey)).filter((it) => !(it.key === w.fromKey && it.category === w.fromCategory));

      const sourceDropdownHtml = sourceOpen ? `
        <div class="header-dropdown configure-trigger-dropdown">
          ${sourceItems.map((o) => `
            <button class="header-dropdown-item${o.key === w.fromKey && o.category === w.fromCategory ? ' active' : ''}" data-wire-edit-index="${idx}" data-wire-edit-side="source" data-wire-target-key="${o.key}" data-wire-target-category="${o.category}">
              ${wireEndpointFullLabel(o.key, o.category)}
            </button>
          `).join('')}
        </div>
      ` : '';
      const destDropdownHtml = destOpen ? `
        <div class="header-dropdown configure-trigger-dropdown">
          ${destItems.length === 0 ? '<div class="configure-trigger-empty">Nothing else here.</div>' : destItems.map((o) => `
            <button class="header-dropdown-item${o.key === w.toKey && o.category === w.toCategory ? ' active' : ''}" data-wire-edit-index="${idx}" data-wire-edit-side="dest" data-wire-target-key="${o.key}" data-wire-target-category="${o.category}">
              ${wireEndpointFullLabel(o.key, o.category)}
            </button>
          `).join('')}
        </div>
      ` : '';

      return `
        <div class="configure-position-line configure-wire-connection-row">
          <div class="configure-wire-connection-main">
            <div class="configure-trigger-wrap configure-trigger-wrap-source">
              <button class="header-selection-btn configure-trigger-btn" data-wire-reopen-index="${idx}" data-wire-reopen-side="source">${wireEndpointLabel(w.fromKey, w.fromCategory)}<span class="header-caret">&#9662;</span></button>
              ${sourceDropdownHtml}
            </div>
            <span class="configure-wire-arrow">&rarr;</span>
            <div class="configure-trigger-wrap">
              <button class="header-selection-btn configure-trigger-btn" data-wire-reopen-index="${idx}" data-wire-reopen-side="dest">${wireEndpointLabel(w.toKey, w.toCategory)}<span class="header-caret">&#9662;</span></button>
              ${destDropdownHtml}
            </div>
            ${renderWireColorRow(w.color || DEFAULT_PRIMARY_COLOR, String(idx))}
          </div>
          <button class="configure-wire-remove-btn" data-wire-index="${idx}" title="Remove wire">&times;</button>
        </div>
      `;
    }).join('');

    // The pending (not-yet-committed) wire's own row - dimmed/disabled
    // until a destination location has actually been clicked on the
    // map (pendingWireDestTarget), per spec. Its options come from
    // THAT clicked location, never from configureTarget - configureTarget
    // stays on the source the whole time (see handleMapClick). Source
    // editing for a still-pending wire lives in the header instead
    // (see renderHeaderWirePickers) - this row only handles the
    // destination side until the wire actually exists.
    let liveDropdownHtml = '';
    if (isPending) {
      const hasDest = !!pendingWireDestTarget;
      const destItems = hasDest ? itemsAtTarget(pendingWireDestTarget).filter((it) => !sameWireEndpoint(it, item)) : [];
      const existingTargets = new Set(fromWires.map(({ w }) => w.toKey + '|' + w.toCategory));
      const isOpen = !!configureWireDropdownOpen && configureWireDropdownOpen.index === 'pending' && configureWireDropdownOpen.side === 'dest';
      const dropdownHtml = isOpen && hasDest ? `
        <div class="header-dropdown configure-trigger-dropdown">
          ${destItems.length === 0 ? '<div class="configure-trigger-empty">Nothing else here.</div>' : destItems.map((o) => `
            <button class="header-dropdown-item" data-wire-target-key="${o.key}" data-wire-target-category="${o.category}" ${existingTargets.has(o.key + '|' + o.category) ? 'disabled' : ''}>
              ${wireEndpointFullLabel(o.key, o.category)}
            </button>
          `).join('')}
        </div>
      ` : '';
      liveDropdownHtml = `
        <div class="configure-position-line configure-wire-connection-row">
          <div class="configure-wire-connection-main">
            <span>Connected to:</span>
            <div class="configure-trigger-wrap">
              <button class="header-selection-btn configure-trigger-btn" id="configureWireDestBtn" ${hasDest ? '' : 'disabled'}>Choose\u2026<span class="header-caret">&#9662;</span></button>
              ${dropdownHtml}
            </div>
          </div>
          <button class="configure-wire-remove-btn" id="configureWireCancelBtn" title="Cancel this wire">&times;</button>
        </div>
      `;
    }

    return `
      <div class="configure-item-row">
        <div class="configure-item-header">
          <div class="configure-item-preview">${preview}</div>
          <div class="configure-item-text">
            <div class="configure-item-type settings-row-label">${categoryLabel}</div>
            <div class="configure-item-name settings-row-label">${nameLabel}</div>
          </div>
          <button class="configure-wire-plus-btn" data-wire-plus-key="${item.key}" data-wire-plus-category="${item.category}" title="Start a new wire from here">+</button>
        </div>
        ${connectionRows}
        ${liveDropdownHtml}
      </div>
    `;
  }

  function renderConfigureItem(item) {
    const type = findType(item.category, item.typeId);
    const preview = type ? previewForType(item.category, type) : '';
    const categoryLabel = item.category.charAt(0).toUpperCase() + item.category.slice(1);
    const nameLabel = item.typeId.charAt(0).toUpperCase() + item.typeId.slice(1);

    // Structures (including doors) and textures have a rotation
    // concept; walls don't yet, and Logic never will (it's not a
    // physical object with an orientation) - no rotation line at all
    // for it, not just a missing button.
    const hasRotation = item.category === 'structure' || item.category === 'texture';
    const showRotationLine = item.category !== 'logic';
    const rotation = hasRotation ? (rotationMapFor(item).get(item.key) || 0) : 0;

    // X/Z from the edge's or cell's own col/row - col=0,row=0 is the
    // map's origin, so these are already "distance from center" with
    // no extra transform needed. This is a 2D map for now, but built
    // to sit inside a future 3D/multi-floor coordinate space - X and
    // (map) row map to the ground-plane X/Z axes, and Y is reserved
    // for vertical position (which floor/level), always 0 until
    // multi-floor actually exists. What used to be labeled "Y" here
    // (the row) is now labeled Z; don't confuse this row-derived Z
    // with a future rotation/height value - it's still just the row.
    // Derived from the key's own shape (does it have a ':') rather
    // than category/typeId special-casing, so this works the same for
    // an edge-placed Logic piece as it does for a wall or a door.
    let posX, posZ;
    if (item.key.indexOf(':') !== -1) {
      const edge = parseWallKey(item.key);
      posX = edge.col; posZ = edge.row;
    } else {
      const [c, r] = item.key.split(',').map(Number);
      posX = c; posZ = r;
    }

    // Logic has no color system yet either - skip the whole Colors
    // subsection for it rather than showing chips that'd read from the
    // wrong Map (colorMapFor has no 'logic' case of its own).
    const hasColors = item.category !== 'logic';
    const hasSecondary = item.category !== 'wall'; // walls have no secondary color concept yet

    // Lever and door each get one on/off-style setting; switches get
    // the full trigger-configuration block (see renderSwitchTriggerSettings).
    // Nothing else has a Settings entry yet, so this is a simple type
    // check rather than a general mechanism. All of it lives in its
    // own "Settings" subsection - separate from Positioning, since
    // none of it is a position/orientation fact about the object the
    // way X/Y/Z or Rotation are.
    let toggle = null;
    if (item.typeId === 'lever') {
      toggle = { map: 'leverOnStates', label: 'Off/On', isOn: leverOnStates.get(item.key) || false };
    } else if (item.typeId === 'door') {
      toggle = { map: 'doorOpenStates', label: 'Closed/Open', isOn: doorOpenStates.get(item.key) || false };
    }
    const isSwitch = item.typeId === 'switch';
    const logicRenderer = LOGIC_SETTINGS_RENDERERS[item.typeId];

    const hasSettings = !!toggle || isSwitch || !!logicRenderer;

    return `
      <div class="configure-item-row">
        <div class="configure-item-header">
          <div class="configure-item-preview">${preview}</div>
          <div class="configure-item-text">
            <div class="configure-item-type settings-row-label">${categoryLabel}</div>
            <div class="configure-item-name settings-row-label">${nameLabel}</div>
          </div>
        </div>

        <div class="configure-subsection-label">Positioning</div>
        <div class="configure-position-line">X: ${posX} &nbsp; Y: 0 &nbsp; Z: ${posZ}</div>
        ${showRotationLine ? `
        <div class="configure-position-line configure-rotation-line">
          <span>Rotation: ${rotation * 90}&deg;</span>
          ${hasRotation ? `<button class="configure-rotate-btn" data-rotate-key="${item.key}" data-rotate-map="${item.typeId === 'door' ? 'doors' : item.category === 'texture' ? 'textureRotations' : 'structureRotations'}" title="Rotate 90\u00b0">${RESET_ICON}</button>` : ''}
        </div>` : ''}

        ${hasSettings ? `
        <div class="configure-subsection-label">Settings</div>
        ${isSwitch ? renderSwitchTriggerSettings(item, 'sidebar') : logicRenderer ? logicRenderer(item, 'sidebar') : toggle ? `
        <div class="configure-position-line configure-toggle-row">
          <span>${toggle.label}</span>
          <button class="configure-toggle-switch${toggle.isOn ? ' on' : ''}" data-toggle-key="${item.key}" data-toggle-map="${toggle.map}" title="${toggle.isOn ? 'On' : 'Off'}">
            <span class="configure-toggle-thumb"></span>
          </button>
        </div>` : ''}` : ''}

        ${hasColors ? `
        <div class="configure-subsection-label">Colors</div>
        ${renderConfigureColorRow(item, 'primary', 'Primary')}
        ${hasSecondary ? renderConfigureColorRow(item, 'secondary', 'Secondary') : ''}` : ''}
      </div>
    `;
  }

  // `source` defaults to 'sidebar' since every OTHER call site (wall/
  // texture/structure's own generic Colors subsection) only ever
  // renders in the sidebar - the header uses its own compact
  // renderHeaderConfigureColorBox layout for those instead. Recolor's
  // "Set Color" is the one case that reuses this full row layout in
  // BOTH surfaces (see renderRecolorColorField), so it passes its own
  // source through explicitly rather than always checking 'sidebar'.
  function renderConfigureColorRow(item, which, label, source) {
    source = source || 'sidebar';
    const overrides = getItemColorOverride(item);
    const defaults = defaultColorsFor(item);
    const hex = overrides[which] || defaults[which];
    const isManual = !!overrides[which];
    const isPickerOpen = !!(configureColorPickerOpen && configureColorPickerOpen.source === source && configureColorPickerOpen.key === item.key && configureColorPickerOpen.category === item.category && configureColorPickerOpen.which === which);
    const isHexEditing = !!(configureHexEditing && configureHexEditing.source === source && configureHexEditing.key === item.key && configureHexEditing.category === item.category && configureHexEditing.which === which);

    return `
      <div class="configure-color-row">
        <span class="configure-color-label settings-row-label">${label}:</span>
        <div class="configure-color-chip">
          <button class="configure-color-circle-btn" style="background:${hex}" data-color-key="${item.key}" data-color-which="${which}" data-color-category="${item.category}" data-color-source="${source}" title="Choose color"></button>
          ${isHexEditing
            ? `<input type="text" class="configure-color-hex-input" data-hex-key="${item.key}" data-hex-which="${which}" data-hex-category="${item.category}" data-hex-source="${source}" value="${hex}" maxlength="7" spellcheck="false">`
            : `<button class="configure-color-hex-btn" data-hex-key="${item.key}" data-hex-which="${which}" data-hex-category="${item.category}" data-hex-source="${source}">${hex}</button>`}
        </div>
        <button class="configure-color-reset-btn" data-reset-key="${item.key}" data-reset-which="${which}" data-reset-category="${item.category}" title="Reset to default" ${isManual ? '' : 'disabled'}>${RESET_ICON}</button>
        ${isPickerOpen ? renderConfigureColorPicker(hex) : ''}
      </div>
    `;
  }

  // The same visual SV-square-plus-sliders picker as the header's
  // Paint mini-picker (renderColorDropdown) - reusing its CSS classes
  // so it looks identical - but wired independently (see
  // wireConfigurePanel) since this one edits whichever placed item's
  // color is currently targeted, not the global paint color.
  function renderConfigureColorPicker(hex) {
    const hsv = hexToHsv(hex);
    const hueGradient = 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)';
    const satGradient = `linear-gradient(to right, ${hsvToHex(hsv.h, 0, hsv.v)}, ${hsvToHex(hsv.h, 100, hsv.v)})`;
    const valGradient = `linear-gradient(to right, ${hsvToHex(hsv.h, hsv.s, 0)}, ${hsvToHex(hsv.h, hsv.s, 100)})`;
    return `
      <div class="header-dropdown header-color-dropdown configure-color-dropdown">
        <div class="sv-square sv-square-mini" id="configureSvSquare" style="--sv-hue:${hsv.h}">
          <div class="sv-square-marker" id="configureSvMarker" style="left:${hsv.s}%;top:${100 - hsv.v}%;"></div>
        </div>
        <div class="paint-sliders paint-sliders-mini">
          <div class="paint-slider-row"><label>Hue</label><input type="range" id="configureHueSlider" min="0" max="360" value="${hsv.h}" style="--track-gradient: ${hueGradient}"></div>
          <div class="paint-slider-row"><label>Saturation</label><input type="range" id="configureSatSlider" min="0" max="100" value="${hsv.s}" style="--track-gradient: ${satGradient}"></div>
          <div class="paint-slider-row"><label>Brightness</label><input type="range" id="configureValSlider" min="0" max="100" value="${hsv.v}" style="--track-gradient: ${valGradient}"></div>
        </div>
      </div>
    `;
  }

  function wireConfigurePanel() {
    // :not([data-rotate-step]) - Move's own rotate buttons carry that
    // attribute and are handled by wireLogicSettingsControls instead
    // (they need to reach into a sequence step sometimes), so this
    // generic handler only ever sees structure/texture/door rotates.
    sideScrollEl.querySelectorAll('.configure-rotate-btn:not([data-rotate-step])').forEach((btn) => {
      btn.addEventListener('click', () => {
        pushUndoSnapshot();
        const mapsByName = { doors, structureRotations, textureRotations };
        const map = mapsByName[btn.dataset.rotateMap] || structureRotations;
        const key = btn.dataset.rotateKey;
        map.set(key, ((map.get(key) || 0) + 1) % 4);
        window.BattleMap.requestRedraw();
        renderDrawTab();
        renderHeaderLeft();
      });
    });

    sideScrollEl.querySelectorAll('.configure-toggle-switch').forEach((btn) => {
      btn.addEventListener('click', () => {
        pushUndoSnapshot();
        const mapsByName = LOGIC_TOGGLE_MAPS_BY_NAME;
        const map = mapsByName[btn.dataset.toggleMap];
        if (!map) return;
        const key = btn.dataset.toggleKey;
        const current = map.has(key) ? map.get(key) : btn.dataset.toggleDefault === 'true';
        map.set(key, !current);
        window.BattleMap.requestRedraw();
        renderDrawTab();
        renderHeaderLeft();
      });
    });
    wireLogicSettingsControls(sideScrollEl, () => { renderDrawTab(); renderHeaderLeft(); });

    // Switch's "Trigger on:" picker - same open/close-toggle-then-pick
    // shape as every other header-selection-btn dropdown in this file
    // (see e.g. wireHeaderWirePickers). Picking a mode is a real data
    // change (undo-tracked, same as any other Settings mutation) even
    // when it re-selects the current value - matches the wire endpoint
    // dropdowns' own unconditional pushUndoSnapshot().
    sideScrollEl.querySelectorAll('[data-switch-trigger-toggle-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.switchTriggerToggleKey;
        const source = btn.dataset.switchTriggerToggleSource;
        const already = switchTriggerDropdownOpen && switchTriggerDropdownOpen.key === key && switchTriggerDropdownOpen.source === source;
        switchTriggerDropdownOpen = already ? null : { key, source };
        renderDrawTab();
        renderHeaderLeft();
      });
    });
    sideScrollEl.querySelectorAll('[data-switch-trigger-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        switchTriggerModes.set(btn.dataset.switchTriggerKey, btn.dataset.switchTriggerMode);
        switchTriggerDropdownOpen = null;
        renderDrawTab();
        renderHeaderLeft();
      });
    });

    // Wire mode - the "+" starts (or restarts) a pending wire from
    // that item; its "Connected to:" dropdown is dimmed/disabled until
    // a destination location has actually been clicked on the map
    // (pendingWireDestTarget), then lists items at THAT location -
    // never wherever configureTarget happens to be, since configureTarget
    // deliberately never moves during wire creation (see
    // handleMapClick). Picking an option there commits the wire and
    // resets all the pending state (see the person's own spec:
    // "everything else just resets after a wire has been placed").
    // Every ALREADY-committed wire is its own live dropdown too, not
    // static text - reopening it repoints the wire in place rather
    // than requiring delete-and-recreate. The per-connection "x"
    // removes a wire outright, no confirmation - same no-ceremony
    // deletion as everywhere else in this app.
    sideScrollEl.querySelectorAll('.configure-wire-plus-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingWireSource = { key: btn.dataset.wirePlusKey, category: btn.dataset.wirePlusCategory };
        pendingWireDestTarget = null;
        configureWireDropdownOpen = null;
        hideMapContextMenu(); // clears a stale destination-picker left over from whatever wire (if any) was in progress before
        window.BattleMap.requestRedraw(); // the source highlight needs to show up immediately
        renderDrawTab();
        renderHeaderLeft(); // the header's own [ITEM] -> [ITEM] pair reads this same state
      });
    });
    const wireDestBtn = sideScrollEl.querySelector('#configureWireDestBtn');
    if (wireDestBtn) {
      wireDestBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const already = configureWireDropdownOpen && configureWireDropdownOpen.index === 'pending' && configureWireDropdownOpen.side === 'dest';
        configureWireDropdownOpen = already ? null : { index: 'pending', side: 'dest' };
        renderDrawTab();
      });
    }
    const wireCancelBtn = sideScrollEl.querySelector('#configureWireCancelBtn');
    if (wireCancelBtn) {
      wireCancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelPendingWire();
      });
    }
    // Reopening EITHER endpoint of an already-committed wire - which
    // one is tracked via data-wire-reopen-side ('source' or 'dest'),
    // so the two buttons on one wire's row can be open independently
    // (though only one dropdown total is ever open across the whole
    // panel - opening either one closes whatever else was open).
    sideScrollEl.querySelectorAll('[data-wire-reopen-index]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.wireReopenIndex);
        const side = btn.dataset.wireReopenSide;
        const already = configureWireDropdownOpen && configureWireDropdownOpen.index === idx && configureWireDropdownOpen.side === side;
        configureWireDropdownOpen = already ? null : { index: idx, side };
        renderDrawTab();
      });
    });
    sideScrollEl.querySelectorAll('[data-wire-target-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        pushUndoSnapshot();
        if (btn.dataset.wireEditIndex !== undefined) {
          // Repointing an existing wire's source OR destination in
          // place - which field actually changes depends entirely on
          // which button opened this dropdown (see data-wire-edit-side
          // above); the wire itself doesn't move or get recreated,
          // just one of its two endpoints. A source change alone is
          // what "moves" a wire's LISTING to a different item's
          // section - see renderWireItemRow's own comment on why that
          // needs no extra code here.
          const idx = Number(btn.dataset.wireEditIndex);
          if (btn.dataset.wireEditSide === 'source') {
            wires[idx].fromKey = btn.dataset.wireTargetKey;
            wires[idx].fromCategory = btn.dataset.wireTargetCategory;
          } else {
            wires[idx].toKey = btn.dataset.wireTargetKey;
            wires[idx].toCategory = btn.dataset.wireTargetCategory;
          }
        } else if (pendingWireSource) {
          // Committing the pending wire.
          wires.push({
            fromKey: pendingWireSource.key,
            fromCategory: pendingWireSource.category,
            toKey: btn.dataset.wireTargetKey,
            toCategory: btn.dataset.wireTargetCategory,
            color: wireDrawColor,
          });
          pendingWireSource = null;
          pendingWireDestTarget = null;
        } else {
          return;
        }
        configureWireDropdownOpen = null;
        hideMapContextMenu(); // stale otherwise if the map's own popup was showing when this got completed via the sidebar instead
        window.BattleMap.requestRedraw();
        renderDrawTab();
        renderHeaderLeft(); // a commit here clears pendingWireSource - the header needs to reflect that too
      });
    });
    sideScrollEl.querySelectorAll('.configure-wire-remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        wires.splice(Number(btn.dataset.wireIndex), 1);
        configureWireDropdownOpen = null; // indices shift after a splice - any open dropdown's index would be stale
        window.BattleMap.requestRedraw();
        renderDrawTab();
      });
    });
    wireWireColorRows(sideScrollEl, renderDrawTab);

    sideScrollEl.querySelectorAll('.configure-color-circle-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.colorKey, which = btn.dataset.colorWhich, category = btn.dataset.colorCategory;
        const alreadyOpen = configureColorPickerOpen && configureColorPickerOpen.key === key && configureColorPickerOpen.category === category && configureColorPickerOpen.which === which;
        if (!alreadyOpen) pushUndoSnapshot(); // one undo step covers the whole editing session, not each individual drag tick - see the picker's own wiring below
        configureColorPickerOpen = alreadyOpen ? null : { key, which, category, source: 'sidebar' };
        configureHexEditing = null;
        renderDrawTab();
        renderHeaderLeft(); // the header's own color box needs to reflect the picker opening/closing too
        window.BattleMap.requestRedraw(); // the highlight is suppressed while a picker's open (see renderOverlay) - needs to update the instant this toggles, not on the next incidental mousemove
      });
    });

    sideScrollEl.querySelectorAll('.configure-color-hex-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        configureHexEditing = { key: btn.dataset.hexKey, which: btn.dataset.hexWhich, category: btn.dataset.hexCategory, source: 'sidebar' };
        configureColorPickerOpen = null;
        renderDrawTab();
        const input = sideScrollEl.querySelector('.configure-color-hex-input');
        if (input) { input.focus(); input.select(); }
      });
    });

    sideScrollEl.querySelectorAll('.configure-color-hex-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      const commit = () => {
        const category = input.dataset.hexCategory, key = input.dataset.hexKey, which = input.dataset.hexWhich;
        let val = input.value.trim();
        if (val && !val.startsWith('#')) val = '#' + val;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          pushUndoSnapshot();
          setItemColorOverride({ category, key }, which, val.toLowerCase());
          window.BattleMap.requestRedraw();
        }
        configureHexEditing = null;
        renderDrawTab();
        renderHeaderLeft();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { configureHexEditing = null; renderDrawTab(); }
      });
      input.addEventListener('blur', commit);
    });

    sideScrollEl.querySelectorAll('.configure-color-reset-btn').forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        clearItemColorOverride({ category: btn.dataset.resetCategory, key: btn.dataset.resetKey }, btn.dataset.resetWhich);
        window.BattleMap.requestRedraw();
        renderDrawTab();
        renderHeaderLeft();
      });
    });

    const colorDropdown = sideScrollEl.querySelector('.configure-color-dropdown');
    if (colorDropdown) colorDropdown.addEventListener('click', (e) => e.stopPropagation()); // same reasoning as the header's own dropdown - see that wiring for why

    const svSquare = sideScrollEl.querySelector('#configureSvSquare');
    if (svSquare) {
      svSquare.addEventListener('mousedown', (e) => {
        configureColorDragActive = true;
        configureColorDragContainer = sideScrollEl;
        applyConfigureSVFromPointer(e.clientX, e.clientY);
      });
    }
    ['configureHueSlider', 'configureSatSlider', 'configureValSlider'].forEach((id) => {
      const el = sideScrollEl.querySelector('#' + id);
      if (el) el.addEventListener('input', () => { configureColorDragContainer = sideScrollEl; applyConfigureSliderInput(); });
    });
  }

  // The header's own wiring for renderHeaderEditPickers/
  // renderHeaderConfigureDetails - called from renderHeaderLeft on
  // every render, same as wireConfigurePanel is called from
  // renderDrawTab. Every handler here mirrors one in wireConfigurePanel
  // and re-renders BOTH surfaces, since Edit mode's header and sidebar
  // are meant to be fully redundant, live mirrors of each other.
  function wireHeaderConfigureDetails() {
    const itemSelectBtn = headerLeftEl.querySelector('#configureItemSelectBtn');
    if (itemSelectBtn) {
      itemSelectBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        configureItemDropdownOpen = !configureItemDropdownOpen;
        configureSettingsDropdownOpen = false;
        renderHeaderLeft();
      });
    }
    headerLeftEl.querySelectorAll('[data-header-item-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        configureSelectedItem = { key: btn.dataset.headerItemKey, category: btn.dataset.headerItemCategory };
        configureItemDropdownOpen = false;
        renderHeaderLeft();
        renderDrawTab();
      });
    });

    headerLeftEl.querySelectorAll('.configure-rotate-btn:not([data-rotate-step])').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const mapsByName = { doors, structureRotations, textureRotations };
        const map = mapsByName[btn.dataset.rotateMap] || structureRotations;
        const key = btn.dataset.rotateKey;
        map.set(key, ((map.get(key) || 0) + 1) % 4);
        window.BattleMap.requestRedraw();
        renderHeaderLeft();
        renderDrawTab();
      });
    });

    headerLeftEl.querySelectorAll('[data-header-color-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.headerColorKey, which = btn.dataset.headerColorWhich, category = btn.dataset.headerColorCategory;
        const alreadyOpen = configureColorPickerOpen && configureColorPickerOpen.key === key && configureColorPickerOpen.category === category && configureColorPickerOpen.which === which;
        if (!alreadyOpen) pushUndoSnapshot();
        configureColorPickerOpen = alreadyOpen ? null : { key, which, category, source: 'header' };
        configureHexEditing = null;
        renderHeaderLeft();
        renderDrawTab();
        window.BattleMap.requestRedraw();
      });
    });
    headerLeftEl.querySelectorAll('[data-header-reset-key]').forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        clearItemColorOverride({ category: btn.dataset.headerResetCategory, key: btn.dataset.headerResetKey }, btn.dataset.headerResetWhich);
        window.BattleMap.requestRedraw();
        renderHeaderLeft();
        renderDrawTab();
      });
    });
    // Recolor's own "Set Color" row reuses renderConfigureColorRow's
    // full row layout (chip+hex+reset+picker) in BOTH surfaces, unlike
    // wall/texture/structure's Colors subsection which only ever
    // appears in the sidebar (the header shows those via the separate
    // [data-header-color-key] boxes above instead) - so this header
    // copy of the same four handlers only ever fires for a Recolor row
    // actually rendered here, mirroring the sidebar's own handlers.
    headerLeftEl.querySelectorAll('.configure-color-circle-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.colorKey, which = btn.dataset.colorWhich, category = btn.dataset.colorCategory, source = btn.dataset.colorSource || 'header';
        const alreadyOpen = configureColorPickerOpen && configureColorPickerOpen.key === key && configureColorPickerOpen.category === category && configureColorPickerOpen.which === which && configureColorPickerOpen.source === source;
        if (!alreadyOpen) pushUndoSnapshot();
        configureColorPickerOpen = alreadyOpen ? null : { key, which, category, source };
        configureHexEditing = null;
        renderHeaderLeft();
        renderDrawTab();
        window.BattleMap.requestRedraw();
      });
    });
    headerLeftEl.querySelectorAll('.configure-color-hex-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        configureHexEditing = { key: btn.dataset.hexKey, which: btn.dataset.hexWhich, category: btn.dataset.hexCategory, source: btn.dataset.hexSource || 'header' };
        configureColorPickerOpen = null;
        renderHeaderLeft();
        const input = headerLeftEl.querySelector('.configure-color-hex-input');
        if (input) { input.focus(); input.select(); }
      });
    });
    headerLeftEl.querySelectorAll('.configure-color-hex-input').forEach((input) => {
      input.addEventListener('click', (e) => e.stopPropagation());
      const commit = () => {
        const category = input.dataset.hexCategory, key = input.dataset.hexKey, which = input.dataset.hexWhich;
        let val = input.value.trim();
        if (val && !val.startsWith('#')) val = '#' + val;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          pushUndoSnapshot();
          setItemColorOverride({ category, key }, which, val.toLowerCase());
          window.BattleMap.requestRedraw();
        }
        configureHexEditing = null;
        renderHeaderLeft();
        renderDrawTab();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { configureHexEditing = null; renderHeaderLeft(); }
      });
      input.addEventListener('blur', commit);
    });
    headerLeftEl.querySelectorAll('.configure-color-reset-btn').forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        clearItemColorOverride({ category: btn.dataset.resetCategory, key: btn.dataset.resetKey }, btn.dataset.resetWhich);
        window.BattleMap.requestRedraw();
        renderHeaderLeft();
        renderDrawTab();
      });
    });

    const swapBtn = headerLeftEl.querySelector('#configureSwapColorsBtn');
    if (swapBtn) {
      swapBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const item = { category: swapBtn.dataset.swapCategory, key: swapBtn.dataset.swapKey };
        const overrides = getItemColorOverride(item);
        const defaults = defaultColorsFor(item);
        const primary = overrides.primary || defaults.primary;
        const secondary = overrides.secondary || defaults.secondary;
        setItemColorOverride(item, 'primary', secondary);
        setItemColorOverride(item, 'secondary', primary);
        window.BattleMap.requestRedraw();
        renderHeaderLeft();
        renderDrawTab();
      });
    }

    const colorDropdown = headerLeftEl.querySelector('.configure-color-dropdown');
    if (colorDropdown) colorDropdown.addEventListener('click', (e) => e.stopPropagation());

    const svSquare = headerLeftEl.querySelector('#configureSvSquare');
    if (svSquare) {
      svSquare.addEventListener('mousedown', (e) => {
        configureColorDragActive = true;
        configureColorDragContainer = headerLeftEl;
        applyConfigureSVFromPointer(e.clientX, e.clientY);
      });
    }
    ['configureHueSlider', 'configureSatSlider', 'configureValSlider'].forEach((id) => {
      const el = headerLeftEl.querySelector('#' + id);
      if (el) el.addEventListener('input', () => { configureColorDragContainer = headerLeftEl; applyConfigureSliderInput(); });
    });

    const settingsBtn = headerLeftEl.querySelector('#configureSettingsBtn');
    if (settingsBtn && !settingsBtn.disabled) {
      settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        configureSettingsDropdownOpen = !configureSettingsDropdownOpen;
        configureItemDropdownOpen = false;
        renderHeaderLeft();
      });
    }
    headerLeftEl.querySelectorAll('.configure-toggle-switch').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        const mapsByName = LOGIC_TOGGLE_MAPS_BY_NAME;
        const map = mapsByName[btn.dataset.toggleMap];
        if (!map) return;
        const key = btn.dataset.toggleKey;
        const current = map.has(key) ? map.get(key) : btn.dataset.toggleDefault === 'true';
        map.set(key, !current);
        window.BattleMap.requestRedraw();
        renderHeaderLeft();
        renderDrawTab();
      });
    });
    wireLogicSettingsControls(headerLeftEl, () => { renderHeaderLeft(); renderDrawTab(); });

    // Switch's "Trigger on:" picker - header mirror of the sidebar
    // wiring above (see that copy's own comment).
    headerLeftEl.querySelectorAll('[data-switch-trigger-toggle-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.switchTriggerToggleKey;
        const source = btn.dataset.switchTriggerToggleSource;
        const already = switchTriggerDropdownOpen && switchTriggerDropdownOpen.key === key && switchTriggerDropdownOpen.source === source;
        switchTriggerDropdownOpen = already ? null : { key, source };
        renderHeaderLeft();
        renderDrawTab();
      });
    });
    headerLeftEl.querySelectorAll('[data-switch-trigger-mode]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndoSnapshot();
        switchTriggerModes.set(btn.dataset.switchTriggerKey, btn.dataset.switchTriggerMode);
        switchTriggerDropdownOpen = null;
        renderHeaderLeft();
        renderDrawTab();
      });
    });
  }

  // configureColorDragContainer is whichever surface's picker is
  // actually open (sideScrollEl or headerLeftEl - see that state's own
  // comment) - the square/sliders being dragged only exist inside that
  // one container, so every DOM read below is scoped to it.
  function applyConfigureSVFromPointer(clientX, clientY) {
    const target = configureColorPickerOpen;
    const container = configureColorDragContainer;
    const sq = container && container.querySelector('#configureSvSquare');
    if (!target || !sq) return;
    const rect = sq.getBoundingClientRect();
    const s = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
    const v = Math.max(0, Math.min(100, 100 - ((clientY - rect.top) / rect.height) * 100));
    const hueSlider = container.querySelector('#configureHueSlider');
    const h = hueSlider ? Number(hueSlider.value) : 0;
    applyConfigureHSV(target, h, s, v);
  }

  function applyConfigureSliderInput() {
    const target = configureColorPickerOpen;
    const container = configureColorDragContainer;
    if (!target || !container) return;
    const h = Number(container.querySelector('#configureHueSlider').value);
    const s = Number(container.querySelector('#configureSatSlider').value);
    const v = Number(container.querySelector('#configureValSlider').value);
    applyConfigureHSV(target, h, s, v);
  }

  function applyConfigureHSV(target, h, s, v) {
    const hex = hsvToHex(h, s, v);
    setPickerTargetHex(target, hex);
    window.BattleMap.requestRedraw();
    updateConfigurePickerLive(h, s, v, hex, target);
  }

  // Same idea as the header's updateHeaderPickerLive - live DOM
  // updates during a drag/slider-input without a full renderDrawTab(),
  // which would rebuild the square/marker (and the input the user's
  // actively dragging) out from under the gesture. The square/marker/
  // sliders only exist inside whichever container actually opened the
  // picker, but the plain swatch buttons (the sidebar's own circle,
  // the header's own box) exist in BOTH surfaces at once - Edit mode's
  // redundancy means both need to reflect the new color live, not just
  // whichever one is mid-drag - so those two lookups go through
  // document.querySelectorAll rather than being scoped to one container.
  function updateConfigurePickerLive(h, s, v, hex, target) {
    const container = configureColorDragContainer;
    const sq = container && container.querySelector('#configureSvSquare');
    if (sq) sq.style.setProperty('--sv-hue', h);
    const marker = container && container.querySelector('#configureSvMarker');
    if (marker) { marker.style.left = s + '%'; marker.style.top = (100 - v) + '%'; }
    const hueSlider = container && container.querySelector('#configureHueSlider');
    const satSlider = container && container.querySelector('#configureSatSlider');
    const valSlider = container && container.querySelector('#configureValSlider');
    if (hueSlider) hueSlider.value = h;
    if (satSlider) satSlider.value = s;
    if (valSlider) valSlider.value = v;
    if (hueSlider) hueSlider.style.setProperty('--track-gradient', 'linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red)');
    if (satSlider) satSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, 0, v)}, ${hsvToHex(h, 100, v)})`);
    if (valSlider) valSlider.style.setProperty('--track-gradient', `linear-gradient(to right, ${hsvToHex(h, s, 0)}, ${hsvToHex(h, s, 100)})`);
    if (target.stepsMapName) {
      document.querySelectorAll(`.configure-step-color-swatch[data-step-color-picker-key="${target.key}"][data-step-color-picker-steps-map="${target.stepsMapName}"][data-step-color-picker-index="${target.stepIndex}"]`).forEach((btn) => { btn.style.background = hex; });
      document.querySelectorAll(`.configure-step-color-hex-btn[data-step-hex-toggle-key="${target.key}"][data-step-hex-toggle-steps-map="${target.stepsMapName}"][data-step-hex-toggle-index="${target.stepIndex}"]`).forEach((btn) => { btn.textContent = hex; });
    } else {
      document.querySelectorAll(`.configure-color-circle-btn[data-color-key="${target.key}"][data-color-category="${target.category}"][data-color-which="${target.which}"]`).forEach((btn) => { btn.style.background = hex; });
      document.querySelectorAll(`.configure-color-hex-btn[data-hex-key="${target.key}"][data-hex-category="${target.category}"][data-hex-which="${target.which}"]`).forEach((btn) => { btn.textContent = hex; });
      document.querySelectorAll(`.header-color-box[data-header-color-key="${target.key}"][data-header-color-category="${target.category}"][data-header-color-which="${target.which}"]`).forEach((btn) => { btn.style.background = hex; });
    }
  }

  function renderDrawTab() {
    if (activeTool === 'select') {
      const header = '<div class="settings-section-header draw-section-header-first"><h4>Select</h4></div>';
      const body = '<p class="menu-placeholder">TBA: Action Log from Play mode</p>';
      sideScrollEl.innerHTML = header + body;
      return;
    }

    if (activeTool === 'paint') {
      sideScrollEl.innerHTML = renderPaintModePanel();
      wirePaintModePanel();
      return;
    }

    if (activeTool === 'configure') {
      sideScrollEl.innerHTML = renderConfigurePanel();
      wireConfigurePanel();
      return;
    }

    sideScrollEl.innerHTML = `
      <div class="settings-section-header draw-section-header-first"><h4>Walls</h4></div>
      ${renderWallSwatchRow()}

      <div class="settings-section-header"><h4>Textures</h4></div>
      ${renderTextureSwatchRow()}

      <div class="settings-section-header"><h4>Structures</h4></div>

      ${renderStructureSwatchRow()}

      <div class="settings-section-header"><h4>Logic</h4></div>
      ${renderLogicSwatchRow()}
    `;

    sideScrollEl.querySelectorAll('.draw-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const category = btn.dataset.category;
        const id = btn.dataset.id;
        // Clicking the already-selected swatch deselects it, same as
        // toggling a tool off - there's no reason placement should
        // stay "loaded" once the DM's told it to stop. Only applies
        // while Place is actually the active tool, though - if Place
        // was put down via its hotkey (activeTool no longer 'place')
        // and the DM re-clicks the same last-used swatch to re-equip
        // it, that click should re-arm Place immediately, not read as
        // "deselect" just because `selected` still remembers it from
        // before. Without this guard that first click was silently a
        // no-op (deselect-then-nothing) and re-equipping took two.
        if (activeTool === 'place' && selected && selected.category === category && selected.id === id) {
          selected = null;
        } else {
          setSelected({ category, id });
          activeTool = 'place'; // selecting something to place always arms Place - no separate step to remember
        }
        // The mode itself is never reset by changing selection - only
        // its meaning, when parked in the non-Click slot, adapts to
        // whatever's actually valid for the new selection (Line only
        // applies to walls; anything else falls back to Drag).
        if (placeMode !== 'click') {
          placeMode = (selected && selected.category === 'wall') ? 'line' : 'drag';
        }
        renderDrawTab();
        renderHeaderLeft();
      });
    });
  }

  window.SideTabRenderers.draw = renderDrawTab;
  // The header's tool icons/Mode buttons only make sense while Draw
  // is the active side tab - registering here (alongside the sidebar
  // content renderer above) means switching to any other tab clears
  // this out automatically, the same way the sidebar itself clears.
  window.SideTabHeaderRenderers = window.SideTabHeaderRenderers || {};
  window.SideTabHeaderRenderers.draw = renderHeaderLeft;

  // One-time listeners driving the header's SV square drag (see
  // colorDragTarget) - registered exactly once here rather than once
  // per render inside renderHeaderLeft, which would otherwise leave a
  // fresh, never-removed pair behind every time the color dropdown
  // opens.
  window.addEventListener('mousemove', (e) => {
    if (!colorDragTarget) return;
    applyHeaderSVFromPointer(colorDragTarget, e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (!colorDragTarget) return;
    const target = colorDragTarget;
    colorDragTarget = null;
    commitPaintColorToRecents(target === 'primary' ? paintPrimaryColor : paintSecondaryColor);
    renderDrawTab();
  });

  // Same one-time pattern for the sidebar's SV square (see
  // svDragActive) - avoids the exact same leak the color wheel above
  // was fixed for.
  window.addEventListener('mousemove', (e) => {
    if (!svDragActive) return;
    applySVFromPointer(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (!svDragActive) return;
    svDragActive = false;
    commitPaintColorToRecents(paintColorTarget === 'primary' ? paintPrimaryColor : paintSecondaryColor);
    renderDrawTab();
  });

  // Same one-time pattern again for the Configure panel's own SV
  // square (see configureColorDragActive) - a third, independent
  // instance of this pattern since it edits per-item overrides rather
  // than the global paint color the two above share.
  window.addEventListener('mousemove', (e) => {
    if (!configureColorDragActive) return;
    applyConfigureSVFromPointer(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (!configureColorDragActive) return;
    configureColorDragActive = false;
    renderDrawTab(); // the live in-drag patching (updateConfigurePickerLive) only touches a few elements directly - this catches the rest (the reset button's disabled state, in particular)
    renderHeaderLeft(); // same catch-up for the header's own reset button state
  });

  // Same one-time pattern again for the wire color picker (see
  // wireColorDragActive) - a fourth, independent instance, since it
  // can be dragged from either the sidebar or the header and needs to
  // remember which (wireColorDragContainer) to keep updating the right
  // DOM tree's #wireSvSquare regardless of where the mouse ends up.
  window.addEventListener('mousemove', (e) => {
    if (!wireColorDragActive) return;
    applyWireSVFromPointer(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', () => {
    if (!wireColorDragActive) return;
    wireColorDragActive = false;
    const rerender = wireColorDragContainer === headerLeftEl ? renderHeaderLeft : renderDrawTab;
    rerender();
  });

  // Clicking anywhere outside the dropdown buttons themselves (which
  // stop propagation - see renderHeaderLeft) closes whichever
  // category/item dropdown is open.
  document.addEventListener('click', () => {
    if (!categoryDropdownOpen && !itemDropdownOpen && !colorDropdownOpen && !headerRecentDropdownOpen && !headerFavoriteDropdownOpen && !favoriteRemoveConfirmHex && !headerWireSourceDropdownOpen && !headerWireDestDropdownOpen) return;
    categoryDropdownOpen = false;
    itemDropdownOpen = false;
    colorDropdownOpen = null;
    headerRecentDropdownOpen = false;
    headerFavoriteDropdownOpen = false;
    headerWireSourceDropdownOpen = false;
    headerWireDestDropdownOpen = false;
    renderHeaderLeft();
    if (favoriteRemoveConfirmHex) {
      favoriteRemoveConfirmHex = null;
      renderDrawTab();
    }
  });

  // Same idea, for the Configure panel's own color picker/hex input,
  // and the switch trigger / wire destination dropdowns - separate
  // listener since it drives renderDrawTab (sidebar) rather than
  // renderHeaderLeft, and shouldn't fire on every click if Configure
  // isn't even the active tool. Doesn't touch pendingWireSource itself
  // - closing the dropdown isn't the same as abandoning the wire (see
  // equipTool/the Configure mode-switch handler for where that's
  // actually cleared).
  document.addEventListener('click', () => {
    // configureWireDropdownOpen is either null or an { index, side }
    // object (never a bare falsy index) since the source/dest split -
    // still checked against null explicitly rather than as a boolean,
    // just no longer for the 0-index reason that used to apply.
    if (!configureColorPickerOpen && !configureHexEditing && !configureItemDropdownOpen && !configureSettingsDropdownOpen && configureWireDropdownOpen === null && !wireColorPickerOpen && !wireHexEditing && !switchTriggerDropdownOpen && !logicTriggerDropdownOpen && !logicFieldDropdownOpen) return;
    const pickerWasOpen = !!configureColorPickerOpen || !!wireColorPickerOpen;
    configureColorPickerOpen = null;
    configureHexEditing = null;
    configureItemDropdownOpen = false;
    configureSettingsDropdownOpen = false;
    configureWireDropdownOpen = null;
    wireColorPickerOpen = null;
    wireHexEditing = null;
    switchTriggerDropdownOpen = null;
    logicTriggerDropdownOpen = null;
    logicFieldDropdownOpen = null;
    renderDrawTab();
    renderHeaderLeft();
    if (pickerWasOpen) window.BattleMap.requestRedraw();
  });

  window.BattleMap.onClick(handleMapClick);
  window.BattleMap.onLine(handleLineGesture);
  window.BattleMap.onSelect(handleSelectGesture);
  window.BattleMap.onArrange(handleArrangeGesture);
  window.BattleMap.addOverlayRenderer(renderOverlay);

  // Right-click - Wire mode's own use of the generic context menu
  // (see showWireContextMenu). Same location bookkeeping left-click
  // already does in handleMapClick (so the highlight/sidebar/header
  // stay in sync regardless of which button was used), plus actually
  // opening the menu, which left-click no longer does at all.
  window.BattleMap.onContextMenu((info, clientX, clientY) => {
    if (activeTool !== 'configure' || configureMode !== 'wire') return;
    const target = { col: info.col, row: info.row, edge: info.edge };
    if (pendingWireSource) {
      pendingWireDestTarget = target;
    } else {
      configureTarget = target;
    }
    renderDrawTab();
    renderHeaderLeft();
    window.BattleMap.requestRedraw();
    showWireContextMenu(target, clientX, clientY);
  });

  // The menu sits INSIDE #mapViewport in the DOM (see index.html), so
  // without this, a mousedown on it (picking an item is a real click,
  // which starts with a mousedown) bubbles straight up to the
  // viewport's own mousedown handler - stopPropagation on the later
  // 'click' event doesn't stop that, mousedown/mouseup are separate
  // events entirely. Left unguarded, choosing an item from the menu
  // ALSO registered as a plain click on whatever was underneath it,
  // corrupting the pick (see the person's own bug report - it was
  // selecting the wall under the menu instead of the menu item).
  if (mapContextMenuEl) {
    mapContextMenuEl.addEventListener('mousedown', (e) => e.stopPropagation());
  }
  // Standard context-menu dismissal - left-click anywhere outside it
  // closes it without picking anything. The menu's own item buttons
  // already stopPropagation on their own 'click' (see
  // renderMapContextMenu), so a genuine pick never reaches here.
  document.addEventListener('click', () => {
    if (mapContextMenu) hideMapContextMenu();
  });

  // 1-9 - equips whichever tool sits at that position in TOOL_DEFS,
  // same toggle behavior as clicking its header button. Only live
  // while the Draw tab is actually open - these numbers don't mean
  // anything to Spawn/Spells/Play, and shouldn't quietly hijack them
  // from another tab's own use of the same keys later.
  window.addEventListener('keydown', (e) => {
    if (!window.isSideTabActive('draw')) return;
    if (e.repeat) return; // holding a number key would otherwise rapid-fire equip/unequip
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // don't collide with Ctrl+1 etc. (tab switching and the like)
    const num = Number(e.key);
    if (!Number.isInteger(num) || num < 1 || num > 9) return;
    const tool = TOOL_DEFS[num - 1];
    if (!tool) return;
    e.preventDefault();
    equipTool(tool.id);
  });

  // Tab used to put the current tool down here - now that any tool
  // can be toggled off with its own 1-9 hotkey (see equipTool), Tab
  // is free to mean something else - see app.js, which now uses it
  // to collapse/expand the sidebar instead.

  // R - cycles the rotation baked into the NEXT structure or texture
  // placed (see placeRotation/cyclePlaceRotation) - doors included,
  // since they're a structure type (see STRUCTURE_TYPES). Only live
  // while Place is armed with a structure or texture actually selected
  // - rotation is meaningless outside that context, so this
  // deliberately doesn't fire for walls or with no tool equipped. Same
  // guards (Draw tab active, not typing in a field, no modifier) as
  // the 1-9 handler above.
  window.addEventListener('keydown', (e) => {
    if (!window.isSideTabActive('draw')) return;
    if (e.repeat) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'r') return;
    if (activeTool !== 'place' || !selected || (selected.category !== 'structure' && selected.category !== 'texture')) return;
    e.preventDefault();
    cyclePlaceRotation();
  });

  // Q - toggles the active tool's own Mode buttons (Click/Line/Drag for
  // Place, Click/Selection for Delete, Click/Drag for Paint, Edit/Wire
  // for Configure) - same effect as clicking whichever Mode button
  // isn't currently active. No-op with no tool equipped. Same guards
  // (Draw tab active, not typing in a field, no modifier) as the other
  // hotkeys.
  window.addEventListener('keydown', (e) => {
    if (!window.isSideTabActive('draw')) return;
    if (e.repeat) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() !== 'q') return;
    if (activeTool !== 'select' && activeTool !== 'place' && activeTool !== 'delete' && activeTool !== 'paint' && activeTool !== 'configure') return;
    e.preventDefault();
    cycleActiveToolMode();
  });

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Y to redo - independent of whether a
  // tool is currently equipped, same as most apps' undo shortcuts.
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const key = e.key.toLowerCase();
    if (key === 'z') {
      e.preventDefault();
      undo();
    } else if (key === 'y') {
      e.preventDefault();
      redo();
    }
  });

  loadPersistedPaintColors();

  // app.js already defaults activeSideTab to 'draw' and marks the tab
  // button active in the static HTML, but it can't render this tab's
  // actual content - this file didn't exist yet when that ran. This
  // is the first real paint of the sidebar and header.
  setActiveSideTab('draw');
  renderHeaderLeft();
})();
