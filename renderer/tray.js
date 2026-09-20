// tray.js
//
// The creature tray - a GREY feature (see the GREY/GREEN convention in
// app.js): always available, whether or not Initiative Tracker is
// connected, and present in every side tab (Draw/Spawn/Spells/Play),
// since it's a property of the map itself, not of any one tab. Owns:
//
//   - The tray UI itself (the strip of token circles that slides in
//     from the right edge - #creatureTrayWrapper/#creatureTrayList in
//     index.html) and its collapse toggle.
//   - Every creature token's state - tray (unplaced) or on the map
//     (placed, grid-snapped to a cell - see cellKeyOf), including a
//     small API (getAt/moveTo/deleteAt/placedKeys/snapshot/restore)
//     that draw-tab.js's own tool system reaches into.
//   - Drawing placed tokens onto the map canvas - exposed as
//     renderTokens(ctx, view) and called explicitly by draw-tab.js's
//     own renderOverlay, at the point in its layer order that draws
//     tokens between Structures and Logic (see renderOverlay's own
//     comment). A second, genuinely separate map.js
//     addOverlayRenderer registration (below) draws ONLY the green
//     drop-target highlight previews (tray-to-map drop, and the
//     Spawn-tab reposition drag) - those always belong on top of
//     everything, the same way draw-tab.js's own Arrange-mode
//     highlight does, so that one stays a self-registered overlay
//     renderer rather than being folded into renderTokens.
//
// Tokens are placed/moved/deleted through draw-tab.js's own Select
// (Arrange mode) and Delete tools, the same as a wall/texture/
// structure/logic piece - see the "DRAW-TAB.JS INTEGRATION" comment on
// window.CreatureTray's API below, and draw-tab.js's own
// findGrabbableAt/moveItem/handleMapClick/handleSelectGesture/
// snapshotState/restoreState, each of which now also checks/calls into
// this file for the 'token' category. tray.js itself only ever handles
// the ONE action that's genuinely its own and has no existing tool
// equivalent: dragging a token out of the tray and dropping it
// somewhere on the map for the first time (see the viewport drop
// listener below).
//
// Two ways a token gets created, mirroring the rest of this app's
// GREEN convention:
//
//   Standalone (not paired) - clicking a card in BT's own local
//   Bestiary (spawn-tab.js) creates a token directly, right here,
//   the same way IT's own Bestiary card click spawns a ledger entry
//   there. BT owns this token outright; nothing round-trips anywhere.
//
//   Paired - clicking a card asks IT to load that creature into its
//   ledger (spawn-tab.js sends requestSpawnEntity; see IT's
//   remoteSpawnEntity), the same as a real click on IT's own Bestiary
//   card would. IT's ledger is the source of truth here, same as the
//   Bestiary itself already is for paired mode: this file never
//   creates a paired token on its own, only ever in reaction to an
//   'entity-sync' push (see syncFromEntities) - so what's in the tray/
//   on the map always matches what IT's ledger (BT's own "Initiative
//   Compiler") actually has loaded, including a removal that happened
//   directly in IT rather than from BT's own map.

(function () {
  // Grid squares are 32 CSS px at zoom=1 (see map.js's own CELL_SIZE) -
  // duplicated here rather than reached into map.js's private state,
  // same "second, independent constant" precedent this project already
  // uses elsewhere (BT's spawn-tab.js duplicating IT's NAME_MAX_LENGTH/
  // HP_MIN/HP_MAX rather than importing them).
  const CELL_SIZE = 32;
  const TOKEN_RADIUS_RATIO = 0.42; // fraction of one grid cell

  // Small, self-contained hex helpers for the token's own text-contrast
  // switch (see renderTokens) - draw-tab.js has its own hex/HSV
  // conversions, but they're private to its closure and this needs
  // exactly one number, not a whole color-picker's worth of machinery.
  function hexToRgb(hex) {
    const clean = String(hex || '').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    const n = parseInt(full, 16) || 0;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  // ITU-R BT.601 perceived-brightness weighting, 0-255 - green reads
  // brightest to the eye and blue darkest, so a flat RGB average would
  // call a pure blue "medium" when it actually looks dark (and a pure
  // yellow "medium" when it looks bright). This is what decides black
  // vs. white text on a token's own secondary (backing) color.
  function perceivedBrightness(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (r * 299 + g * 587 + b * 114) / 1000;
  }

  const trayWrapper = document.getElementById('creatureTrayWrapper');
  const trayList = document.getElementById('creatureTrayList');
  const collapseBtn = document.getElementById('creatureTrayCollapseBtn');
  const viewport = document.getElementById('mapViewport');

  // { id, name, acronym, number (string or null), placed, cellKey
  //   ("col,row", same format as draw-tab.js's own cellKey() - only set
  //   while placed), remoteEntityId (IT's entity id, or null for a
  //   standalone token), sourceId (bestiaryCreatures id standalone /
  //   templateId paired) }[]
  let tokens = [];
  let collapsed = false;
  let nextLocalId = 1;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function makeTokenId() {
    return 'tok-' + (nextLocalId++) + '-' + Date.now().toString(36);
  }

  // Matches draw-tab.js's own cellKey(col, row) format exactly - every
  // category (walls aside, which key off an edge instead) uses this
  // same "col,row" string, which is what lets several categories
  // (texture + structure + logic + now token) all occupy one cell's
  // key independently, in their own separate stores, the same way
  // they already do today.
  function cellKeyOf(col, row) {
    return col + ',' + row;
  }

  // "Wolf 2" -> { base: "Wolf", number: "2" }. A unique creature (no
  // trailing number, same as IT's own isUnique naming) just comes back
  // as { base: "Tiamat", number: null }.
  function splitTrailingNumber(rawName) {
    const trimmed = String(rawName || '').trim();
    const match = /^(.*\S)\s+(\d+)$/.exec(trimmed);
    if (match) return { base: match[1], number: match[2] };
    return { base: trimmed, number: null };
  }

  // First letter of the first two words ("Fire Elemental" -> "FE"), or
  // the first two letters of a one-word name ("Wolf" -> "WO") - always
  // two characters, which is what actually fits legibly inside a token
  // this size.
  function acronymOf(base) {
    const words = String(base || '').split(/\s+/).filter(Boolean);
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return '??';
  }

  function tokenAt(cellKey) {
    return tokens.find((t) => t.placed && t.cellKey === cellKey) || null;
  }

  // ---------------------------------------------------------------------
  // Token creation
  // ---------------------------------------------------------------------

  // Standalone - BT's own local Bestiary card click. Numbers the same
  // way IT's createEntityFromTemplate does (count of existing tokens
  // sharing this source creature, +1) - BT's simplified local Bestiary
  // has no isUnique concept of its own, so every standalone creature is
  // treated as the numbered case.
  function spawnLocal(creature) {
    const priorCount = tokens.filter((t) => t.sourceId === creature.id).length;
    const number = String(priorCount + 1);
    tokens.push({
      id: makeTokenId(),
      name: `${creature.name} ${number}`,
      acronym: acronymOf(creature.name),
      number,
      placed: false,
      cellKey: null,
      remoteEntityId: null,
      sourceId: creature.id,
    });
    renderTray();
  }

  // Paired - reconciles the tray/map against IT's latest ledger push.
  // Never mutates a token's own PLACEMENT (cellKey/placed) for an
  // entity that's still present - only adds tokens for newly-loaded
  // entities and drops tokens for ones no longer on IT's ledger,
  // whichever side removed them. It DOES, however, refresh a still-
  // present token's name/acronym/number from e.name every push (see
  // the update loop below) - IT's ledger is what's authoritative for
  // a creature's name, exactly the same way it's already authoritative
  // for which entities exist at all, so a rename made in IT (clicking
  // a loaded entity's name in the compiler and editing it) has to
  // reach an already-placed token too, not just a brand new one.
  // e.name is IT's own fully-computed display name - already built by
  // IT's own naming/numbering logic (no trailing number for a unique
  // creature, "Base N" otherwise) - so this never recomputes numbering
  // itself, just mirrors whatever IT is currently calling it,
  // including a rename that drops the number entirely. Not itself an
  // undo-able action (same reasoning as spawnLocal - IT's ledger is
  // authoritative here, not something BT's own Undo should be
  // rewinding).
  function syncFromEntities(entityList) {
    const list = Array.isArray(entityList) ? entityList : [];
    const currentIds = new Set(list.map((e) => String(e.id)));
    let changed = false;

    const before = tokens.length;
    tokens = tokens.filter((t) => t.remoteEntityId === null || currentIds.has(String(t.remoteEntityId)));
    if (tokens.length !== before) changed = true;

    const byId = new Map(list.map((e) => [String(e.id), e]));
    for (const t of tokens) {
      if (t.remoteEntityId === null) continue;
      const e = byId.get(String(t.remoteEntityId));
      if (!e || e.name === t.name) continue;
      const { base, number } = splitTrailingNumber(e.name);
      t.name = e.name;
      t.acronym = acronymOf(base);
      t.number = number;
      changed = true;
    }

    const known = new Set(tokens.filter((t) => t.remoteEntityId !== null).map((t) => String(t.remoteEntityId)));
    for (const e of list) {
      if (known.has(String(e.id))) continue;
      const { base, number } = splitTrailingNumber(e.name);
      tokens.push({
        id: makeTokenId(),
        name: e.name,
        acronym: acronymOf(base),
        number,
        placed: false,
        cellKey: null,
        remoteEntityId: e.id,
        sourceId: e.templateId,
      });
      changed = true;
    }

    if (changed) {
      renderTray();
      window.BattleMap.requestRedraw();
      // A name/acronym/number change needs to reach the Configure
      // tool's own sidebar/header too, not just the tray and the map
      // token itself - otherwise a creature already selected there
      // shows its OLD name until re-picked, in both directions: an
      // IT-side rename lands here as exactly this kind of push, and so
      // does the far end of BT's own paired-rename round trip (see
      // window.CreatureTray.renameToken) - the local name doesn't
      // actually change until this same push comes back. renderDrawTab/
      // renderHeaderLeft re-read every Map/CreatureTray call live, so a
      // plain repaint is all this needs - see refreshConfigurePanel's
      // own comment.
      if (window.BattleDraw && window.BattleDraw.refreshConfigurePanel) window.BattleDraw.refreshConfigurePanel();
    }
  }

  // Dragged out of the tray and dropped on the map - the one placement
  // path that's genuinely tray.js's own (every other category is
  // placed via the Place tool instead). Snaps to whichever cell the
  // drop landed in and refuses a cell that's already got a token,
  // rather than silently displacing whatever creature was there -
  // unlike a wall/texture/structure's placement, which does replace
  // an existing occupant, losing track of a creature that way felt
  // like the wrong default. Undoable, same as any other placement -
  // see window.BattleDraw.pushUndoSnapshot.
  function placeFromTray(tokenId, col, row) {
    const key = cellKeyOf(col, row);
    if (tokenAt(key)) return; // occupied - refuse; the tray token stays put, the DM can pick a different cell
    const t = tokens.find((x) => x.id === tokenId);
    if (!t || t.placed) return;
    if (window.BattleDraw && window.BattleDraw.pushUndoSnapshot) window.BattleDraw.pushUndoSnapshot();
    t.placed = true;
    t.cellKey = key;
    renderTray();
    window.BattleMap.requestRedraw();
  }

  // What the DM would actually call this creature - "Ghoul 1"/
  // "Ghoul 2"/"Goblin 1" standalone, same shape paired (numbered
  // unless IT has the creature set unique, in which case no number at
  // all), always reflecting a rename made in IT's own compiler. This
  // is just t.name - the Configure panel's per-creature row (draw-
  // tab.js's renderConfigureItem) reaches this rather than reading
  // t.name directly only so it has one place to call, matching every
  // other cross-file read of token state. t.name itself is what stays
  // current: spawnLocal sets it once and it never changes again for a
  // standalone token (nothing else renames it), while syncFromEntities
  // above keeps a paired token's t.name mirrored to IT's own e.name on
  // every entity-sync push, including a rename that removes its
  // number - see that function's own comment for why this is the
  // right field to trust instead of anything derived locally (like
  // the token's own internal id, which never changes and so can't
  // reflect a rename at all).
  function displayNameFor(t) {
    return t.name;
  }

  // Configure tool's rename button (draw-tab.js's renderConfigureItem
  // 'token' row) - one edit box that means something different
  // depending on how this token got here, same split spawnLocal/
  // syncFromEntities already draw:
  //   - Standalone (remoteEntityId === null): this IS the compiler,
  //     there being none to defer to, so it does locally exactly what
  //     IT's own click-to-rename commit does (see IT's app.js
  //     startRenaming) - set the literal name, then re-derive acronym/
  //     number from it with the same splitTrailingNumber every paired
  //     sync already uses, so "change the acronym, change the number"
  //     falls out of one rule instead of two. A real undo-able map
  //     edit, unlike spawnLocal/removeTrayToken (those aren't edits to
  //     anything already on the map).
  //   - Paired (remoteEntityId !== null): IT's ledger is authoritative
  //     (see syncFromEntities' own comment), so this doesn't touch t.*
  //     itself at all - it asks IT to rename the real entity
  //     (window.electronAPI.requestRenameEntity, mirroring
  //     requestRemoveEntity below), and the name/acronym/number here
  //     update themselves the moment IT's reply comes back as its next
  //     entity-sync push, same as any other compiler-side rename
  //     already does. Not pushed onto BT's own undo stack for the same
  //     reason syncFromEntities isn't - the rename actually lives on
  //     IT's side, not something BT's Undo should be rewinding.
  function renameToken(cellKey, rawName) {
    const t = tokenAt(cellKey);
    if (!t) return;
    const newName = String(rawName || '').trim().slice(0, 30);
    if (!newName || newName === t.name) return;
    if (t.remoteEntityId === null) {
      if (window.BattleDraw && window.BattleDraw.pushUndoSnapshot) window.BattleDraw.pushUndoSnapshot();
      const { base, number } = splitTrailingNumber(newName);
      t.name = newName;
      t.acronym = acronymOf(base);
      t.number = number;
      renderTray();
      window.BattleMap.requestRedraw();
    } else if (window.electronAPI && window.electronAPI.requestRenameEntity) {
      window.electronAPI.requestRenameEntity(t.remoteEntityId, newName);
    }
  }

  // Removing a still-in-tray (never placed) token via its own × button -
  // never touched the map, so this isn't an undo-able map edit, same
  // reasoning as spawnLocal not being one either.
  function removeTrayToken(tokenId) {
    const t = tokens.find((x) => x.id === tokenId);
    if (!t || t.placed) return;
    tokens = tokens.filter((x) => x.id !== tokenId);
    if (t.remoteEntityId !== null && window.electronAPI && window.electronAPI.requestRemoveEntity) {
      window.electronAPI.requestRemoveEntity(t.remoteEntityId);
    }
    renderTray();
  }

  // ---------------------------------------------------------------------
  // Tray UI
  // ---------------------------------------------------------------------
  // Persists (stays visible) until every token it's holding has been
  // placed - once the tray list is empty, it hides itself entirely
  // rather than sitting there as an empty strip. Reappears automatically
  // the moment a new token is added (renderTray runs on every change).

  function renderTray() {
    const unplaced = tokens.filter((t) => !t.placed);
    trayWrapper.classList.toggle('hidden', unplaced.length === 0);
    trayList.innerHTML = unplaced.map((t) => `
      <div class="creature-tray-token" data-token-id="${t.id}" draggable="true" title="${escapeHtml(t.name)} — drag onto the map">
        <span class="creature-tray-token-fill">${escapeHtml(t.acronym)}${t.number ? `<small>${escapeHtml(t.number)}</small>` : ''}</span>
        <button type="button" class="creature-tray-token-remove" data-remove-token="${t.id}" title="Remove ${escapeHtml(t.name)}">&times;</button>
      </div>
    `).join('');
    wireTrayTokens();
  }

  let draggedTokenId = null;

  function wireTrayTokens() {
    trayList.querySelectorAll('.creature-tray-token').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        draggedTokenId = el.dataset.tokenId;
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        draggedTokenId = null;
        dragOverCell = null;
        window.BattleMap.requestRedraw();
      });
    });
    trayList.querySelectorAll('[data-remove-token]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrayToken(btn.dataset.removeToken);
      });
    });
  }

  // Collapse - identical styling/behavior to the sidebar's own
  // .side-collapse-tab (see style.css), mirrored to the tray's left
  // edge, and the tray box itself slides fully off to the right when
  // collapsed rather than just fading - same "genuinely leaves the
  // screen via transform" mechanics as .side-col-wrapper.collapsed
  // .side-col. The handle stays put and visible either way (attached
  // to the wrapper, not the sliding box), same as the sidebar's.
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    trayWrapper.classList.toggle('collapsed', collapsed);
    collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
  });

  // ---------------------------------------------------------------------
  // Spawn-tab reposition drag
  // ---------------------------------------------------------------------
  // A second, independent way to move an already-placed token, on top
  // of the Select-tool Arrange-mode path draw-tab.js already wires up
  // (findGrabbableAt/moveItem) - that one only works while Select is
  // the active Draw tool, which the DM has no reason to be sitting in
  // while running combat from the Spawn tab. This one just needs the
  // Spawn tab itself to be active (see window.isSideTabActive in
  // app.js) - no Draw-tool state involved at all, so it works exactly
  // as long as Spawn is the active side tab and no longer, regardless
  // of whatever Draw tool was last armed.
  //
  // A capture-phase document listener so it gets first look at a
  // mousedown before map.js's own viewport listener (bubble phase,
  // non-capture - see map.js) decides it's a pan/paint/etc. gesture
  // instead. Only actually claims the event (stopPropagation) when
  // there's a token under the cursor to grab; otherwise it steps aside
  // and lets the map's own gesture handling run as normal, so panning
  // and every other tool still work fine while Spawn is active.
  let repositionDrag = null; // { token, originKey, col, row } while dragging

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (!window.isSideTabActive || !window.isSideTabActive('spawn')) return;
    if (!viewport.contains(e.target)) return;
    const { worldX, worldY } = window.BattleMap.screenToWorld(e.clientX, e.clientY);
    const col = Math.floor(worldX / CELL_SIZE);
    const row = Math.floor(worldY / CELL_SIZE);
    const t = tokenAt(cellKeyOf(col, row));
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    repositionDrag = { token: t, originKey: t.cellKey, col, row };
    window.BattleMap.requestRedraw();
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!repositionDrag) return;
    const { worldX, worldY } = window.BattleMap.screenToWorld(e.clientX, e.clientY);
    repositionDrag.col = Math.floor(worldX / CELL_SIZE);
    repositionDrag.row = Math.floor(worldY / CELL_SIZE);
    window.BattleMap.requestRedraw();
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!repositionDrag) return;
    if (e.button !== 0) { repositionDrag = null; return; }
    const drag = repositionDrag;
    repositionDrag = null;
    const newKey = cellKeyOf(drag.col, drag.row);
    if (newKey !== drag.originKey) {
      if (tokenAt(newKey)) {
        // occupied - refuse, same as placeFromTray/moveTo; token
        // snaps back to where it started rather than displacing
        // whatever's already there.
      } else if (window.BattleDraw && window.BattleDraw.pushUndoSnapshot) {
        window.BattleDraw.pushUndoSnapshot();
        drag.token.cellKey = newKey;
        // This drag path is separate from draw-tab.js's own Arrange-
        // mode moveItem (see this section's own header comment), so it
        // has to carry the token's own paint override (draw-tab.js's
        // tokenColors, not reachable from here directly) across the
        // move itself, the same way moveItem's own 'token' branch
        // does - otherwise a repainted token would silently revert to
        // its default colors the moment it's dragged while Spawn is
        // active.
        if (window.BattleDraw.moveTokenColor) window.BattleDraw.moveTokenColor(drag.originKey, newKey);
        // Same reasoning as moveTokenColor just above, but for wires -
        // this drag path bypasses draw-tab.js's own moveItem entirely,
        // so nothing else repoints wires that touched this token's old
        // cell. Without this a wired creature dragged from the tray
        // would leave its wires pointing at empty air.
        if (window.BattleDraw.moveTokenWires) window.BattleDraw.moveTokenWires(drag.originKey, newKey);
        // Same reasoning again, for a Configure-tool Label override -
        // otherwise a custom acronym would silently revert to the
        // auto-derived one the moment this token's dragged while Spawn
        // is active.
        if (window.BattleDraw.moveTokenAcronym) window.BattleDraw.moveTokenAcronym(drag.originKey, newKey);
      } else {
        drag.token.cellKey = newKey;
      }
    }
    window.BattleMap.requestRedraw();
  }, true);

  // ---------------------------------------------------------------------
  // Dropping a tray token onto the map
  // ---------------------------------------------------------------------
  // Plain HTML5 drag-and-drop, not one of map.js's own drag gestures
  // (pan/paint/line/select/arrange) - those all start FROM a mousedown
  // on the canvas itself, where this starts from a tray token instead,
  // so it's a separate event stream (dragover/drop) layered on top
  // rather than something map.js needs to know about at all. Snaps to
  // whichever cell the drop point falls in - same col/row math as
  // map.js's own computeCellInfo, duplicated here since that function
  // is private to map.js's closure (see this file's own CELL_SIZE
  // comment for the same "small duplicated constant" reasoning).

  // dragOverCell tracks whichever cell the dragged tray token is
  // currently hovering, so the overlay renderer below can highlight it
  // green - the same "this is where it would land" preview the Select
  // tool's Arrange mode gives an in-progress move (see draw-tab.js's
  // own drawArrangeHighlight), just fed from HTML5 dragover events
  // instead of a mousemove gesture.
  let dragOverCell = null; // { col, row } or null

  viewport.addEventListener('dragover', (e) => {
    if (!draggedTokenId) return;
    e.preventDefault(); // required for 'drop' to actually fire
    const { worldX, worldY } = window.BattleMap.screenToWorld(e.clientX, e.clientY);
    const col = Math.floor(worldX / CELL_SIZE);
    const row = Math.floor(worldY / CELL_SIZE);
    if (!dragOverCell || dragOverCell.col !== col || dragOverCell.row !== row) {
      dragOverCell = { col, row };
      window.BattleMap.requestRedraw();
    }
  });
  viewport.addEventListener('dragleave', (e) => {
    if (!draggedTokenId) return;
    // Only clear once the pointer has actually left the viewport
    // itself, not just moved between two of its children - relatedTarget
    // is null when the drag leaves the window entirely, which also
    // counts.
    if (e.relatedTarget && viewport.contains(e.relatedTarget)) return;
    dragOverCell = null;
    window.BattleMap.requestRedraw();
  });
  viewport.addEventListener('drop', (e) => {
    if (!draggedTokenId) return;
    e.preventDefault();
    const { worldX, worldY } = window.BattleMap.screenToWorld(e.clientX, e.clientY);
    const col = Math.floor(worldX / CELL_SIZE);
    const row = Math.floor(worldY / CELL_SIZE);
    placeFromTray(draggedTokenId, col, row);
    draggedTokenId = null;
    dragOverCell = null;
    window.BattleMap.requestRedraw();
  });

  // ---------------------------------------------------------------------
  // Drawing placed tokens
  // ---------------------------------------------------------------------
  // Called directly by draw-tab.js's own renderOverlay (see
  // window.CreatureTray.renderTokens below and renderOverlay's own
  // comment) at the point in ITS layer order that puts tokens between
  // Structures and Logic - not a self-registered overlay renderer,
  // since that would only ever draw last/on top, which is no longer
  // where tokens belong.

  function renderTokens(ctx, view) {
    const placed = tokens.filter((t) => t.placed);
    if (placed.length === 0) return;

    const radius = view.cellSize * view.zoom * TOKEN_RADIUS_RATIO;

    for (const t of placed) {
      // Mid-drag (Spawn-tab reposition), draw the token at its live
      // drag position instead of its still-unchanged cellKey, same as
      // how draw-tab.js's own Arrange-mode drag would look if it drew
      // the item itself moving (it doesn't - only token dragging does,
      // since a reposition drag here has no separate "ghost preview"
      // layer of its own).
      const isDragging = repositionDrag && repositionDrag.token === t;
      const col = isDragging ? repositionDrag.col : Number(t.cellKey.split(',')[0]);
      const row = isDragging ? repositionDrag.row : Number(t.cellKey.split(',')[1]);
      const cx = view.offsetX + (col + 0.5) * view.cellSize * view.zoom;
      const cy = view.offsetY + (row + 0.5) * view.cellSize * view.zoom;

      // Per-TOKEN paint override (draw-tab.js's own tokenColors,
      // reached through this one seam - see getTokenColors' own
      // comment) rather than the DM's current live Paint selection:
      // outer ring = primary, inner backing = secondary, same two-tone
      // convention every other paintable category already uses, and
      // defaulting the same way theirs do (a fixed default until this
      // specific token has actually been painted).
      const colors = (window.BattleDraw && window.BattleDraw.getTokenColors)
        ? window.BattleDraw.getTokenColors(t.cellKey)
        : { primary: '#14100d', secondary: '#f4ede2' };
      // The acronym/number text switches between white and black
      // depending on the BACKING (secondary) color's own brightness,
      // not a fixed ink color the way every other category's text/
      // icon work does - a token's whole face is that secondary color,
      // so unlike a structure's icon (drawn in a fixed ink over
      // whatever's behind it), legibility here depends entirely on
      // what the DM just painted it.
      const textColor = perceivedBrightness(colors.secondary) > 140 ? '#000000' : '#ffffff';

      ctx.save();
      if (isDragging) ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = colors.secondary;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, radius * 0.12);
      ctx.strokeStyle = colors.primary;
      ctx.stroke();

      // The Configure tool's own Label override (draw-tab.js's
      // tokenAcronymOverrides), if the DM set one - see
      // window.BattleDraw.getTokenAcronym's own comment. Falls back to
      // t.acronym (whatever tray.js auto-derived from the creature's
      // name) exactly like getTokenColors falls back to the fixed
      // default colors until Paint has actually touched this token.
      const label = (window.BattleDraw && window.BattleDraw.getTokenAcronym)
        ? window.BattleDraw.getTokenAcronym(t.cellKey)
        : t.acronym;

      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (t.number) {
        const acronymSize = Math.max(7, radius * 0.55);
        const numberSize = Math.max(6, radius * 0.42);
        ctx.font = `700 ${acronymSize}px sans-serif`;
        ctx.fillText(label, cx, cy - acronymSize * 0.42);
        ctx.font = `600 ${numberSize}px sans-serif`;
        ctx.fillText(t.number, cx, cy + numberSize * 0.55);
      } else {
        const acronymSize = Math.max(8, radius * 0.62);
        ctx.font = `700 ${acronymSize}px sans-serif`;
        ctx.fillText(label, cx, cy);
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------
  // Drop-target highlight previews
  // ---------------------------------------------------------------------
  // The ONE thing this file still registers as a genuine map.js overlay
  // renderer (always drawn last/on top, same as draw-tab.js's own
  // Arrange-mode highlight) - green (#3a9e5c), matching
  // drawArrangeHighlight's own color and alpha scheme exactly, for
  // both ways a token gets dropped onto a cell here: out of the tray
  // (dragOverCell) and repositioned via the Spawn-tab drag above
  // (repositionDrag). A cell already holding a different token is not
  // a valid drop (both paths refuse it - see placeFromTray/the mouseup
  // handler above), so it's shown dimmer, the same distinction
  // drawArrangeHighlight makes between a move's valid and invalid
  // destination.
  function highlightCell(ctx, view, col, row, alpha) {
    const x = view.offsetX + col * view.cellSize * view.zoom;
    const y = view.offsetY + row * view.cellSize * view.zoom;
    const size = view.cellSize * view.zoom;
    ctx.save();
    ctx.fillStyle = '#3a9e5c';
    ctx.strokeStyle = '#3a9e5c';
    ctx.globalAlpha = alpha * 0.35;
    ctx.fillRect(x, y, size, size);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, size, size);
    ctx.restore();
  }

  window.BattleMap.addOverlayRenderer((ctx, view) => {
    if (dragOverCell) {
      const valid = !tokenAt(cellKeyOf(dragOverCell.col, dragOverCell.row));
      highlightCell(ctx, view, dragOverCell.col, dragOverCell.row, valid ? 0.75 : 0.35);
    }
    if (repositionDrag) {
      const originValid = repositionDrag.originKey === cellKeyOf(repositionDrag.col, repositionDrag.row)
        || !tokenAt(cellKeyOf(repositionDrag.col, repositionDrag.row));
      highlightCell(ctx, view, repositionDrag.col, repositionDrag.row, originValid ? 0.75 : 0.35);
    }
  });

  // ---------------------------------------------------------------------
  // Pairing wiring
  // ---------------------------------------------------------------------

  if (window.electronAPI && window.electronAPI.onEntitySync) {
    window.electronAPI.onEntitySync((entities) => syncFromEntities(entities));
  }
  // Same load-order race bestiary-sync has (see BT's main.js
  // lastBestiaryTemplates/get-bestiary-sync comment) - pulls whatever
  // IT last pushed instead of only ever waiting on the next one.
  if (window.electronAPI && window.electronAPI.getEntitySync) {
    window.electronAPI.getEntitySync().then((entities) => syncFromEntities(entities));
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  window.CreatureTray = {
    // spawn-tab.js's creature-card click reaches this for the
    // standalone case; the paired case goes straight to
    // window.electronAPI.requestSpawnEntity instead (see spawn-tab.js),
    // since a paired spawn only ever becomes a token once IT's own
    // entity-sync confirms it (syncFromEntities above).
    spawnLocal,

    // -------------------------------------------------------------
    // DRAW-TAB.JS INTEGRATION - tokens are a placeable "category" the
    // same as wall/texture/structure/logic, grid-snapped and moved/
    // deleted through the Select tool's Arrange mode and the Delete
    // tool rather than a bespoke always-on drag/right-click system.
    // See draw-tab.js's findGrabbableAt (checks getAt), moveItem
    // (calls moveTo for a 'token' category item), handleMapClick's
    // 'delete' branch and handleSelectGesture's rectangle-commit (both
    // call deleteAt), and snapshotState/restoreState (call snapshot/
    // restore so Undo/Redo covers token placement/movement/deletion
    // exactly like everything else placed on the map).
    // -------------------------------------------------------------

    // Returns the token occupying this cell (a draw-tab.js cellKey
    // string), or null.
    getAt: tokenAt,

    // Draws every placed token - called directly from draw-tab.js's
    // own renderOverlay, between its structures loop and its logic
    // loop (see that function's own comment). Not itself an overlay
    // renderer registered with map.js - see the "Drawing placed
    // tokens" section above.
    renderTokens,

    // The Configure panel's per-creature row (draw-tab.js's
    // renderConfigureItem, 'token' category) reaches this for its Name
    // line rather than reading a token's .name directly - see
    // displayNameFor's own comment for why.
    getName(cellKey) {
      const t = tokenAt(cellKey);
      return t ? displayNameFor(t) : '';
    },

    // Configure panel's rename button - see renameToken's own comment
    // for what "rename" means for a standalone vs. paired token.
    renameToken,

    // Lets the Configure panel's rename button show the right hint
    // ("renames locally" vs. "renames in the compiler") without having
    // to reach into a token's own remoteEntityId field directly.
    isPaired(cellKey) {
      const t = tokenAt(cellKey);
      return !!(t && t.remoteEntityId !== null);
    },

    // Relocates a placed token - called from inside draw-tab.js's own
    // moveItem, which is itself only ever reached after
    // handleArrangeGesture's commit has already pushed one undo
    // snapshot for the whole move, so this never pushes its own.
    // Refuses (no-op) if the destination cell already has a different
    // token - see placeFromTray's own comment on why tokens don't
    // replace-on-collision the way every other category does.
    moveTo(oldKey, newKey) {
      if (newKey !== oldKey && tokenAt(newKey)) return;
      const t = tokenAt(oldKey);
      if (!t) return;
      t.cellKey = newKey;
      window.BattleMap.requestRedraw();
    },

    // Removes a placed token outright - called from draw-tab.js's
    // Delete tool (click or rectangle-select), which always pushes its
    // own undo snapshot before calling this, so this never pushes one
    // either (matches every other category's own delete path, where
    // the undo snapshot is always the caller's responsibility).
    deleteAt(cellKey) {
      const t = tokenAt(cellKey);
      if (!t) return;
      tokens = tokens.filter((x) => x !== t);
      if (t.remoteEntityId !== null && window.electronAPI && window.electronAPI.requestRemoveEntity) {
        window.electronAPI.requestRemoveEntity(t.remoteEntityId);
      }
      window.BattleMap.requestRedraw();
    },

    // Every currently-placed token's cellKey - draw-tab.js's own
    // rectangle-select delete iterates this the same way it already
    // iterates walls.keys()/textures.keys()/etc.
    placedKeys() {
      return tokens.filter((t) => t.placed).map((t) => t.cellKey);
    },

    // Undo/redo - a full, deep-cloned copy of every token (tray and
    // placed alike), folded into draw-tab.js's own snapshotState/
    // restoreState. Cheap for the same reason walls/textures/
    // structures already are: the whole list is small.
    snapshot() {
      return tokens.map((t) => ({ ...t }));
    },
    // Restoring a snapshot wholesale (the naive `tokens = snap`) was
    // the bug: a token's EXISTENCE is owned by spawnLocal/
    // syncFromEntities, neither of which is itself undo-tracked (see
    // both functions' own comments - creating/loading a creature isn't
    // something BT's Undo should be rewinding), but a token's
    // PLACEMENT (placed/cellKey) is BT's own to undo/redo (see
    // placeFromTray/moveTo/deleteAt's "Undoable" comments). Overwriting
    // the whole array conflated the two: a creature loaded from IT (or
    // spawned locally) after the snapshot was taken would simply
    // vanish from the tray/map the instant an unrelated BT action got
    // undone, then only reappear once IT pushed another entity-sync
    // (redone, or a different creature added) gave syncFromEntities a
    // reason to re-add it - dropping whatever placement it had in the
    // process.
    //
    // So this merges by id instead: a token that still exists gets its
    // placement fields (only) restored from the snapshot, keeping
    // every current, possibly-since-updated field (name, from a
    // rename - see syncFromEntities) exactly as it is now; a token the
    // snapshot remembers but that's gone now is restored in full -
    // this is what makes Undo bring back a token the Delete tool
    // removed, the same as it already does for a wall/texture/
    // structure/logic piece; a token that exists now but ISN'T in the
    // snapshot (created after it was taken) is left alone rather than
    // dropped.
    restore(snap) {
      const snapTokens = Array.isArray(snap) ? snap.map((t) => ({ ...t })) : [];
      const snapById = new Map(snapTokens.map((t) => [t.id, t]));

      const merged = [];
      const seen = new Set();
      for (const t of tokens) {
        seen.add(t.id);
        const snapT = snapById.get(t.id);
        merged.push(snapT ? { ...t, placed: snapT.placed, cellKey: snapT.cellKey } : t);
      }
      for (const t of snapTokens) {
        if (!seen.has(t.id)) merged.push(t);
      }

      tokens = merged;
      renderTray();
      window.BattleMap.requestRedraw();
    },
  };
})();
