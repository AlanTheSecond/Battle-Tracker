// map.js
//
// The battlemap grid - a GREY feature (see the GREY/GREEN convention
// documented in app.js): always available, whether or not Initiative
// Tracker is connected, and its behavior never changes based on
// pairing state. Owns the pan/zoom viewport and the raw canvas
// drawing loop, plus the drag-gesture primitives (paint, line,
// rectangle-select) that draw-tab.js's tools are built from; anything
// that wants to place content on the map hooks into the small public
// API exposed at the bottom (window.BattleMap) rather than touching
// the canvas or viewport directly.
//
// Grid squares are 32 CSS px at zoom = 1, which comes out to roughly
// a third of an inch on a typical desktop display - Chromium treats
// 96 CSS px as one inch by convention (the standard assumption in the
// absence of the monitor's actual physical PPI, which the browser has
// no reliable way to know). Zoom range is 0.5x-2.5x: squares run from
// about 16px (zoomed out, useful for seeing a whole battlefield at
// once) up to 80px (zoomed in, close to a full inch, useful for fine
// token placement) - starting at 1x/32px/a third of an inch in
// between the two.
//
// The canvas's own backing store is sized to the window, not to the
// (animated) viewport container - see "Canvas sizing" below. This is
// also the fix for the sidebar-collapse cursor/flicker bug: resizing
// a canvas's backing store is a real GPU texture reallocation, not a
// cheap operation, and an earlier version did one on essentially
// every frame of the sidebar's slide animation. Decoupling the canvas
// from the sidebar's width entirely removes that trigger.

(function () {
  const CELL_SIZE = 32;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2.5;
  const DEFAULT_ZOOM = 1;
  const DRAG_THRESHOLD = 4; // px of total movement before a mousedown counts as a pan instead of a click

  const viewport = document.getElementById('mapViewport');
  const canvas = document.getElementById('mapCanvas');
  const ctx = canvas.getContext('2d');

  let zoom = DEFAULT_ZOOM;
  // World-origin's current screen position, in CSS px, relative to
  // the viewport's own top-left corner - panning just moves this,
  // everything else (grid line placement) is derived from it at draw
  // time rather than tracked separately.
  let offsetX = 0;
  let offsetY = 0;

  let isPanning = false;
  let hasDragged = false;
  let mouseDownX = 0;
  let mouseDownY = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;

  // Drag gesture modes, set via the public API's setDragBehavior()
  // (see draw-tab.js's Mode buttons):
  //   'pan'    (default) - dragging pans the map; a plain click fires
  //            the click callback once.
  //   'paint'  - dragging never pans; the click callback fires once
  //              on mousedown and again every time the cursor enters
  //              a new cell/edge while the button stays held, for
  //              continuous placement/deletion (the Drag modes).
  //   'line'   - dragging never pans; onLine's callback gets
  //              start/update/commit phases so the caller can trace a
  //              straight-ish line of edges from the drag's start to
  //              wherever it ends (the Place tool's Line mode).
  //   'select' - dragging never pans; onSelect's callback gets the
  //              same start/update/commit phases for a rectangular
  //              selection instead of a line (the Delete tool's
  //              Selection mode).
  //   'arrange' - dragging never pans; onArrange's callback gets the
  //              same start/update/commit phases again, for the
  //              Select tool's Arrange mode dragging one item from
  //              wherever it starts to wherever the drag ends.
  let dragBehavior = 'pan';
  let isPainting = false;
  let lastPaintedKey = null;
  let isLining = false;
  let lineStartInfo = null;
  let isSelecting = false;
  let selectStartInfo = null;
  let isArranging = false;
  let arrangeStartInfo = null;

  // The grid cell/edge currently under the cursor, kept live so
  // overlay renderers (see draw-tab.js's placement ghost preview) can
  // show what would be placed there without needing to recompute it
  // themselves. null whenever the cursor isn't over the map.
  let hoverInfo = null;

  // ---------------------------------------------------------------
  // Canvas sizing
  // ---------------------------------------------------------------
  // The canvas is always sized to the full window, positioned at the
  // viewport's own local (0,0) via CSS (position: absolute; inset: 0
  // inside the viewport - see style.css), and the viewport itself
  // clips it with overflow: hidden. It's drawn across its entire
  // extent every time regardless of how much of that is currently
  // visible, so growing/shrinking the viewport (the sidebar
  // collapsing or expanding) never needs to touch the canvas at all -
  // it's already fully rendered, and the animation is purely the
  // ordinary, cheap kind of CSS layout change that just reveals or
  // hides more of it. The only thing that legitimately changes the
  // canvas's own size is the actual OS window resizing.
  let canvasCssWidth = 0;
  let canvasCssHeight = 0;

  function resizeCanvasToWindow() {
    const dpr = window.devicePixelRatio || 1;
    canvasCssWidth = window.innerWidth;
    canvasCssHeight = window.innerHeight;
    canvas.width = Math.max(1, Math.round(canvasCssWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvasCssHeight * dpr));
    canvas.style.width = canvasCssWidth + 'px';
    canvas.style.height = canvasCssHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  // ---------------------------------------------------------------
  // Draw scheduling
  // ---------------------------------------------------------------
  // Coalesces every redraw request (pan, zoom, hover, placement) into
  // at most one draw() per animation frame, rather than one per raw
  // input event - see the file header for why that matters.
  let drawScheduled = false;
  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      draw();
    });
  }

  const overlayRenderers = [];
  const clickListeners = [];
  const lineListeners = [];
  const selectListeners = [];
  const contextMenuListeners = [];
  const arrangeListeners = [];

  function draw() {
    const w = canvasCssWidth;
    const h = canvasCssHeight;
    ctx.clearRect(0, 0, w, h);

    const cell = CELL_SIZE * zoom;

    ctx.strokeStyle = '#9a9186'; // decently thin, plain grey - not themed to the red accent, since the grid is the map's own surface, not UI chrome
    ctx.lineWidth = 1;
    ctx.beginPath();

    // Lines start at the first grid line at or before the canvas's
    // own edge (offset can be any real number, including negative,
    // once the map's been panned - normalize into [0, cell) rather
    // than relying on JS's % operator, which returns negative results
    // for a negative dividend).
    const startX = ((offsetX % cell) + cell) % cell;
    for (let x = startX; x <= w; x += cell) {
      const px = Math.round(x) + 0.5; // half-pixel offset keeps a 1px line crisp instead of anti-aliased across two rows
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
    }

    const startY = ((offsetY % cell) + cell) % cell;
    for (let y = startY; y <= h; y += cell) {
      const py = Math.round(y) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
    }

    ctx.stroke();

    const view = { offsetX, offsetY, zoom, cellSize: CELL_SIZE, width: w, height: h, hover: hoverInfo };
    for (const fn of overlayRenderers) fn(ctx, view);
  }

  // Wall edges get their own, deliberately narrow hit zones rather
  // than "whichever of the 4 edges is nearest, always" - a full-cell
  // nearest-edge test means literally any click anywhere resolves to
  // some wall, including dead center of a cell or right on top of a
  // vertex, where it's genuinely ambiguous which of two meeting edges
  // was intended. Each edge instead gets a thin band along its own
  // center - close enough perpendicular to the true line (WALL_BAND)
  // and clear of both corners along its length (WALL_VERTEX_MARGIN) -
  // and a click outside all four bands simply isn't a wall target at
  // all (null), rather than snapping to whatever's technically
  // closest. That's what stops an accidental offshoot in the wrong
  // direction right at a corner.
  const WALL_BAND = 0.2; // how far into the cell, as a fraction of one cell, an edge's hit zone reaches
  const WALL_VERTEX_MARGIN = 0.2; // how much of the edge's own length, at each end, is excluded near its vertices

  function resolveWallEdge(col, row, fracX, fracY) {
    const inLengthRange = (f) => f > WALL_VERTEX_MARGIN && f < 1 - WALL_VERTEX_MARGIN;
    if (fracY < WALL_BAND && inLengthRange(fracX)) return { type: 'h', col, row };
    if (fracY > 1 - WALL_BAND && inLengthRange(fracX)) return { type: 'h', col, row: row + 1 };
    if (fracX < WALL_BAND && inLengthRange(fracY)) return { type: 'v', col, row };
    if (fracX > 1 - WALL_BAND && inLengthRange(fracY)) return { type: 'v', col: col + 1, row };
    return null;
  }

  // Converts a raw mouse position into the grid cell it falls in,
  // plus whichever of that cell's four edges the click landed nearest
  // to (or null - see resolveWallEdge), plus the raw (unsnapped)
  // world position - callers decide for themselves whether they care
  // about the cell (textures/structures), the edge (walls), or the
  // exact point (the Selection rectangle's corners). Reads the
  // viewport's position fresh each time rather than from a cache -
  // this only runs on actual clicks/hovers/drag-updates, not on every
  // pan/zoom frame, so it isn't the kind of hot path that caused
  // trouble before, and a cache would otherwise need its own
  // invalidation logic for every scenario that can move the viewport
  // (window resize, sidebar collapse, ...).
  function computeCellInfo(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const worldX = (px - offsetX) / zoom;
    const worldY = (py - offsetY) / zoom;
    const cellXf = worldX / CELL_SIZE;
    const cellYf = worldY / CELL_SIZE;
    const col = Math.floor(cellXf);
    const row = Math.floor(cellYf);
    const fracX = cellXf - col;
    const fracY = cellYf - row;

    const edge = resolveWallEdge(col, row, fracX, fracY);

    return { col, row, edge, worldX, worldY };
  }

  // info.edge may be null (see resolveWallEdge) - falls back to a
  // fixed placeholder so a click landing outside any wall's hit zone
  // still gets a distinct, stable dedup key of its own rather than
  // throwing.
  function paintKeyFor(info) {
    const edgePart = info.edge ? (info.edge.type + ':' + info.edge.col + ',' + info.edge.row) : 'none';
    return info.col + ',' + info.row + '|' + edgePart;
  }

  // ---------------------------------------------------------------
  // Mouse gestures - mousedown branches by button first (left drives
  // whatever dragBehavior currently says; the mouse/wheel button
  // always pans, regardless of tool; right does nothing for now -
  // see the button check below), then by dragBehavior for left-clicks
  // into pan, paint, line, or select. A mousedown/mouseup pair in
  // 'pan' mode that never moves more than DRAG_THRESHOLD counts as a
  // click instead of a pan (see clickListeners).
  // ---------------------------------------------------------------
  function startPan(e) {
    isPanning = true;
    hasDragged = false;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    viewport.classList.add('panning');
  }

  viewport.addEventListener('mousedown', (e) => {
    if (e.button === 2) return; // right-click - reserved for later, inert for now
    if (e.button === 1) {
      // Mouse/wheel-button click always pans, regardless of the
      // active tool - it's a distinct gesture from left-click and
      // shouldn't be swallowed by whatever tool happens to be armed.
      e.preventDefault(); // stops the OS's native middle-click autoscroll cursor from appearing
      startPan(e);
      return;
    }
    if (e.button !== 0) return; // anything else exotic - ignore

    if (dragBehavior === 'paint') {
      isPainting = true;
      const info = computeCellInfo(e.clientX, e.clientY);
      info.isGestureStart = true;
      lastPaintedKey = paintKeyFor(info);
      for (const fn of clickListeners) fn(info);
      return;
    }
    if (dragBehavior === 'line') {
      isLining = true;
      lineStartInfo = computeCellInfo(e.clientX, e.clientY);
      for (const fn of lineListeners) fn(lineStartInfo, lineStartInfo, 'start');
      return;
    }
    if (dragBehavior === 'select') {
      isSelecting = true;
      selectStartInfo = computeCellInfo(e.clientX, e.clientY);
      for (const fn of selectListeners) fn(selectStartInfo, selectStartInfo, 'start');
      return;
    }
    if (dragBehavior === 'arrange') {
      isArranging = true;
      arrangeStartInfo = computeCellInfo(e.clientX, e.clientY);
      for (const fn of arrangeListeners) fn(arrangeStartInfo, arrangeStartInfo, 'start');
      return;
    }
    startPan(e);
  });

  // Right-click - was fully inert (just suppressing the OS/Electron
  // context menu), now dispatches to whatever's registered via
  // onContextMenu (see window.BattleMap below), same shape as onClick
  // (col/row/edge/worldX/worldY), plus the raw client coordinates a
  // menu actually needs to position itself. Deliberately NOT run
  // through clickListeners - right-click opening a generic, reusable
  // context menu is a different gesture from left-click's per-tool
  // actions, not a variant of it.
  viewport.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const info = computeCellInfo(e.clientX, e.clientY);
    for (const fn of contextMenuListeners) fn(info, e.clientX, e.clientY);
  });

  // Listens on window, not just the viewport, so a drag that happens
  // to end (or a fast drag that momentarily leaves) the viewport
  // bounds doesn't leave panning "stuck" on.
  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    if (!hasDragged) {
      const total = Math.hypot(e.clientX - mouseDownX, e.clientY - mouseDownY);
      if (total > DRAG_THRESHOLD) hasDragged = true;
    }
    offsetX += e.clientX - lastPointerX;
    offsetY += e.clientY - lastPointerY;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    scheduleDraw();
  });

  window.addEventListener('mouseup', (e) => {
    if (isPainting) {
      isPainting = false;
      lastPaintedKey = null;
      return;
    }
    if (isLining) {
      isLining = false;
      const info = computeCellInfo(e.clientX, e.clientY);
      for (const fn of lineListeners) fn(lineStartInfo, info, 'commit');
      lineStartInfo = null;
      return;
    }
    if (isSelecting) {
      isSelecting = false;
      const info = computeCellInfo(e.clientX, e.clientY);
      for (const fn of selectListeners) fn(selectStartInfo, info, 'commit');
      selectStartInfo = null;
      return;
    }
    if (isArranging) {
      isArranging = false;
      const info = computeCellInfo(e.clientX, e.clientY);
      for (const fn of arrangeListeners) fn(arrangeStartInfo, info, 'commit');
      arrangeStartInfo = null;
      return;
    }
    if (!isPanning) return;
    isPanning = false;
    viewport.classList.remove('panning');
    // Only a genuine left-click-without-drag counts as a "click"
    // action - middle-click panning falls through the isPanning/
    // hasDragged path above but should never place/delete anything,
    // even when released without moving.
    if (!hasDragged && e.button === 0) {
      const info = computeCellInfo(e.clientX, e.clientY);
      info.isGestureStart = true;
      for (const fn of clickListeners) fn(info);
    }
  });

  // ---------------------------------------------------------------
  // Hover tracking - separate from the pan-drag listener above (that
  // one's on window and only cares about drags in progress; this one
  // is scoped to the viewport itself and runs regardless of whether a
  // drag is happening, purely so the placement ghost preview always
  // knows what cell/edge is currently under the cursor. Also doubles
  // as the continuous driver for paint/line/select while one of those
  // is in progress.
  // ---------------------------------------------------------------
  viewport.addEventListener('mousemove', (e) => {
    hoverInfo = computeCellInfo(e.clientX, e.clientY);

    if (isPainting) {
      const key = paintKeyFor(hoverInfo);
      if (key !== lastPaintedKey) {
        lastPaintedKey = key;
        hoverInfo.isGestureStart = false;
        for (const fn of clickListeners) fn(hoverInfo);
      }
    } else if (isLining) {
      for (const fn of lineListeners) fn(lineStartInfo, hoverInfo, 'update');
    } else if (isSelecting) {
      for (const fn of selectListeners) fn(selectStartInfo, hoverInfo, 'update');
    } else if (isArranging) {
      for (const fn of arrangeListeners) fn(arrangeStartInfo, hoverInfo, 'update');
    }

    scheduleDraw();
  });
  viewport.addEventListener('mouseleave', () => {
    hoverInfo = null;
    scheduleDraw();
  });

  // ---------------------------------------------------------------
  // Zoom - scroll wheel, centered on the cursor rather than always
  // zooming toward the viewport's center, so whatever the DM is
  // looking at stays under the cursor as it scales.
  // ---------------------------------------------------------------
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();

    const rect = viewport.getBoundingClientRect();
    const pointerX = e.clientX - rect.left;
    const pointerY = e.clientY - rect.top;

    const zoomFactor = Math.exp(-e.deltaY * 0.001);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * zoomFactor));
    if (newZoom === zoom) return;

    const worldX = (pointerX - offsetX) / zoom;
    const worldY = (pointerY - offsetY) / zoom;
    offsetX = pointerX - worldX * newZoom;
    offsetY = pointerY - worldY * newZoom;
    zoom = newZoom;

    scheduleDraw();
  }, { passive: false });

  // ---------------------------------------------------------------
  // Arrow-key panning - always available regardless of tool state.
  // This is a different input channel from mouse-drag panning (which
  // is intentionally only available with no tool selected, since a
  // tool's drag gesture is already claimed for paint/line/select), so
  // there's no gesture conflict to gate it behind.
  //
  // Driven by which arrow keys are currently held (a Set, updated by
  // keydown/keyup) rather than moving a fixed distance per keydown
  // event - a held key naturally repeats keydown at the OS's key-
  // repeat rate, which is inconsistent and produces a jerky, stepped
  // motion. Instead, a single requestAnimationFrame loop runs
  // whenever there's motion to apply, advancing the pan smoothly
  // frame-by-frame based on real elapsed time (so speed doesn't
  // change with the display's refresh rate).
  //
  // Simple physics rather than an instant on/off speed: velocity
  // chases a target (full speed in the held direction, or zero once
  // nothing's held) at a fixed acceleration, so starting ramps up and
  // releasing glides to a stop instead of snapping - it's what makes
  // it feel like panning a real camera with some weight to it rather
  // than teleporting in fixed increments. The loop keeps running
  // after the last key is released, decelerating, and only stops
  // itself once velocity has actually settled back to zero.
  // ---------------------------------------------------------------
  const PAN_MAX_SPEED = 900; // screen px/second at full speed, independent of zoom - same convention as mouse-drag panning, which also moves in screen px 1:1
  const PAN_ACCEL = 2600; // px/second^2 while a direction is held - reaches full speed in ~0.35s
  const PAN_DECEL = 3400; // px/second^2 once nothing's held - a bit brisker than accel so it doesn't feel like it's sliding forever
  const PAN_STOP_EPSILON = 1; // px/second - below this, just call it stopped rather than crawling asymptotically toward zero forever

  const heldArrowKeys = new Set();
  let panVelX = 0;
  let panVelY = 0;
  let panLoopRunning = false;
  let lastPanTimestamp = null;

  function isArrowKey(key) {
    return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
  }

  // Moves `current` toward `target` by at most `rate * dt`, without
  // overshooting - the standard "approach" building block for this
  // kind of frame-by-frame physics.
  function approach(current, target, rate, dt) {
    const diff = target - current;
    const maxDelta = rate * dt;
    if (Math.abs(diff) <= maxDelta) return target;
    return current + Math.sign(diff) * maxDelta;
  }

  function panAnimationFrame(timestamp) {
    const dt = lastPanTimestamp === null ? 0 : Math.min((timestamp - lastPanTimestamp) / 1000, 0.1); // cap dt so a stall/tab-switch can't cause one huge jump when it resumes
    lastPanTimestamp = timestamp;

    let dx = 0, dy = 0;
    if (heldArrowKeys.has('ArrowLeft')) dx += 1;
    if (heldArrowKeys.has('ArrowRight')) dx -= 1;
    if (heldArrowKeys.has('ArrowUp')) dy += 1;
    if (heldArrowKeys.has('ArrowDown')) dy -= 1;

    let targetVX = 0, targetVY = 0;
    if (dx !== 0 || dy !== 0) {
      // Normalized so holding two keys at once (a diagonal) chases the
      // same top speed as one, not faster.
      const len = Math.hypot(dx, dy);
      targetVX = (dx / len) * PAN_MAX_SPEED;
      targetVY = (dy / len) * PAN_MAX_SPEED;
    }

    const rate = heldArrowKeys.size > 0 ? PAN_ACCEL : PAN_DECEL;
    panVelX = approach(panVelX, targetVX, rate, dt);
    panVelY = approach(panVelY, targetVY, rate, dt);

    if (panVelX !== 0 || panVelY !== 0) {
      offsetX += panVelX * dt;
      offsetY += panVelY * dt;
      draw(); // called directly, not scheduleDraw() - this loop already is the once-per-frame driver, so there's no redundant-call storm to coalesce here
    }

    // Once every key is released and velocity has actually decayed
    // back to (near) zero, stop the loop instead of running forever.
    if (heldArrowKeys.size === 0 && Math.abs(panVelX) < PAN_STOP_EPSILON && Math.abs(panVelY) < PAN_STOP_EPSILON) {
      panVelX = 0;
      panVelY = 0;
      panLoopRunning = false;
      lastPanTimestamp = null;
      return;
    }

    requestAnimationFrame(panAnimationFrame);
  }

  window.addEventListener('keydown', (e) => {
    if (!isArrowKey(e.key)) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack arrow keys while typing somewhere

    e.preventDefault();
    if (heldArrowKeys.has(e.key)) return; // key-repeat firing more keydowns while held - already accounted for
    heldArrowKeys.add(e.key);
    if (!panLoopRunning) {
      panLoopRunning = true;
      lastPanTimestamp = null;
      requestAnimationFrame(panAnimationFrame);
    }
  });

  window.addEventListener('keyup', (e) => {
    heldArrowKeys.delete(e.key);
  });

  // If the window loses focus while a key is physically held (alt-tab,
  // clicking into a different app, ...), the keyup never arrives -
  // without this the pan would run forever in whatever direction was
  // last held. The loop itself (still running, now decelerating) is
  // what carries it smoothly to a stop rather than snapping instantly.
  window.addEventListener('blur', () => heldArrowKeys.clear());

  window.addEventListener('resize', resizeCanvasToWindow);
  resizeCanvasToWindow();

  // ---------------------------------------------------------------
  // Public API - draw-tab.js (and later, tokens/floors/etc.) build on
  // this instead of reaching into the canvas or viewport directly.
  // ---------------------------------------------------------------
  window.BattleMap = {
    // cb({ col, row, edge, worldX, worldY }) - fires on every genuine
    // click on the map (not a pan drag), and repeatedly during a drag
    // while in 'paint' mode - see setDragBehavior.
    onClick(cb) { clickListeners.push(cb); },
    // cb(info, clientX, clientY) - fires on right-click. info is the
    // same shape onClick gets; clientX/clientY are the raw event
    // coordinates, for positioning a context menu at the actual
    // cursor rather than snapping to the resolved cell/edge.
    onContextMenu(cb) { contextMenuListeners.push(cb); },
    // cb(startInfo, currentInfo, phase) where phase is 'start',
    // 'update' (fires on every mousemove during the drag), or
    // 'commit' (fires once on mouseup) - only while in 'line' mode.
    onLine(cb) { lineListeners.push(cb); },
    // Same shape as onLine, only while in 'select' mode.
    onSelect(cb) { selectListeners.push(cb); },
    onArrange(cb) { arrangeListeners.push(cb); },
    // fn(ctx, { offsetX, offsetY, zoom, cellSize, width, height, hover }) -
    // called every frame, after the grid lines are drawn, in
    // whatever order renderers were registered.
    addOverlayRenderer(fn) { overlayRenderers.push(fn); scheduleDraw(); },
    requestRedraw: scheduleDraw,
    // 'pan' (default), 'paint', 'line', or 'select' - see the mode
    // list at the dragBehavior declaration above.
    setDragBehavior(mode) {
      dragBehavior = mode;
      viewport.classList.toggle('paint-mode', mode !== 'pan');
    },
  };
})();
