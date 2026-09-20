// spawn-tab.js
//
// The Spawn tab's internal Bestiary - Battle Tracker's own minimal
// creature library, used while Initiative Tracker isn't connected. Per
// the GREY/GREEN convention (see app.js's FEATURE_KIND registry, which
// already tags 'spawn' as 'green'): this is case (a), a simpler
// standalone tool that gets replaced/enhanced once IT is paired. That
// swap-in isn't built yet - this file only builds the standalone side.
//
// Deliberately modeled on Initiative Tracker's own Bestiary sidebar -
// same card list, same "+ New" quick-create form, same
// edit-pencil/delete-x per card, same hover highlight - but "intensely
// simplified" per spec: just Name and HP, nothing else. No Init bonus,
// no Import (that pulls from IT's bundled 5e data, which doesn't exist
// here), no Packages, no drag-to-reorder, no "Advanced" editor - IT's
// own stat block form has all of these, BT's doesn't get any of them.
// A card's body IS click-to-spawn, same as IT's own Bestiary - see the
// sideScrollEl click listener near the end of this file, and tray.js
// for what "spawn" actually means on BT's side (a token in the
// creature tray, not a ledger entry - BT has no ledger of its own).
//
// ---------------------------------------------------------------------
// Paired mode
// ---------------------------------------------------------------------
// Everything above is the standalone (disconnected) case. Once
// Initiative Tracker is actually paired, this whole tab is "entirely
// puppeted" by IT's real Bestiary per the spec: the local
// bestiaryCreatures list above stops being shown at all, replaced by
// whatever IT pushes over in a 'bestiary-sync' message (remoteCreatures
// below); the header grows real Import/Package icon buttons that hand
// off to IT's own modals; a card's Edit pencil opens IT's real Advanced
// editor (via the same window-puppeting handoff) rather than turning
// the card into a local edit form; and "+ New" opens a full IT-style
// quick-create form (Name/Init bonus/HP/Advanced link) instead of the
// simplified local one. Delete is the one exception that does NOT
// puppet the window - it's sent straight over the wire, the same way a
// plain top-level delete in IT itself has no modal of its own either.
//
// Both code paths stay in this one file, side by side, rather than
// splitting into two - itConnected is checked at the point each
// behavior actually differs (which data source, which click handler,
// which form), so the standalone behavior stays exactly what it was
// and is never at risk of regressing just because paired mode exists
// now too.

(function () {
  const sideScrollEl = document.getElementById('sideScroll');

  // ---------------------------------------------------------------------
  // Data + persistence
  // ---------------------------------------------------------------------
  // { id, name, hp }[] - the DM's own creature library, independent of
  // any particular map. Persisted via localStorage the same way Paint's
  // recent/favorite colors are (see draw-tab.js) - unlike placed map
  // content (walls/textures/structures/logic/wires), which has no
  // save/load at all yet (that's a 1.0.0 item - see main.js/preload.js).
  // A hand-built creature library is worth more to lose on every restart
  // than paint-color preferences are, so this persists now even though
  // the rest of the app's content doesn't yet.
  const BESTIARY_STORAGE_KEY = 'bt-bestiary-creatures';

  const NAME_MAX_LENGTH = 30; // matches IT's own NAME_MAX_LENGTH
  const HP_MIN = 1, HP_MAX = 999; // matches IT's own HP_MIN/HP_MAX for a stat block's HP
  const HP_DEFAULT = 10; // matches IT's own #sbHp default
  const MAX_CREATURES = 99; // matches IT's own MAX_TEMPLATES (Bestiary size limit)
  const INIT_MIN = -99, INIT_MAX = 99; // matches IT's own INIT_MIN/INIT_MAX - only used in paired mode's full form
  const INIT_DEFAULT = 0; // matches IT's own #sbInitBonus default

  function formatMod(mod) {
    // Matches IT's own formatMod exactly - a paired-mode card's meta
    // line needs to read the same way IT's sb-meta does.
    return mod >= 0 ? `+${mod}` : `${mod}`;
  }

  let bestiaryCreatures = [];

  function loadBestiary() {
    try {
      const raw = localStorage.getItem(BESTIARY_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) bestiaryCreatures = parsed;
    } catch (e) { /* corrupt or missing - just start empty */ }
  }
  function persistBestiary() {
    try { localStorage.setItem(BESTIARY_STORAGE_KEY, JSON.stringify(bestiaryCreatures)); } catch (e) { /* non-fatal */ }
  }
  loadBestiary();

  // ---------------------------------------------------------------------
  // Pairing state + IT's real Bestiary data
  // ---------------------------------------------------------------------
  // Tracked independently from app.js's own module-scope itConnected
  // (that one lives inside a different IIFE-free top-level scope and
  // isn't exposed on window) - this listens for the same
  // onConnectionStatus push itself. ipcRenderer.on supports any number
  // of listeners for the same channel, so a second one here doesn't
  // step on app.js's.
  let itConnected = false;
  // { id, name, initBonus, hp }[] - IT's own templates, minus packages,
  // exactly as syncBestiaryToBattleTracker() on IT's side builds them.
  // Only meaningful while itConnected is true; left stale (but unused)
  // once disconnected rather than cleared, so a brief reconnect blip
  // doesn't flash the list empty.
  let remoteCreatures = [];

  // Every one of these three listeners can fire while some OTHER
  // side tab is active (Draw, most likely) - none of them may
  // unconditionally re-render, or they'd stomp #sideScroll's current
  // content with the Bestiary regardless of what's actually on screen.
  // window.isSideTabActive is app.js's own exposed check (see its
  // setActiveSideTab) - the state itself (itConnected/remoteCreatures)
  // still updates either way, so whenever the DM does switch to Spawn,
  // setActiveSideTab's own renderSpawnTab() call picks up the latest
  // values immediately rather than something stale.
  function renderIfActive() {
    if (window.isSideTabActive && window.isSideTabActive('spawn')) renderSpawnTab();
  }

  if (window.electronAPI && window.electronAPI.getConnectionStatus) {
    window.electronAPI.getConnectionStatus().then((status) => {
      itConnected = !!(status && status.connected);
      renderIfActive();
    });
  }
  if (window.electronAPI && window.electronAPI.onConnectionStatus) {
    window.electronAPI.onConnectionStatus((payload) => {
      if (payload.app !== 'initiative-tracker') return;
      itConnected = payload.connected;
      // Losing the connection mid-edit would otherwise leave a
      // now-meaningless remote form (editing/creating against a
      // template list that's no longer being pushed to) sitting open -
      // drop back to the closed state so the next render falls
      // straight through to the standalone tab cleanly. closeForm()
      // itself calls renderSpawnTab() unconditionally though, so this
      // only runs it while Spawn is actually active too.
      if (!itConnected && formOpen) {
        formOpen = false;
        renderIfActive();
        return;
      }
      renderIfActive();
    });
  }
  if (window.electronAPI && window.electronAPI.onBestiarySync) {
    window.electronAPI.onBestiarySync((templates) => {
      remoteCreatures = Array.isArray(templates) ? templates : [];
      renderIfActive();
    });
  }
  // Actively pulls whatever IT last pushed, rather than only ever
  // waiting on the push above - if IT was already open when BT
  // connected, IT's own reply can arrive within milliseconds (see
  // BT's main.js comment on lastBestiaryTemplates), often before this
  // very listener has finished registering. Without this, that first
  // sync would just be lost and the Spawn tab would sit empty until
  // some unrelated edit on IT's side happened to trigger another push -
  // this closes that race the same way getConnectionStatus already
  // does for itConnected above.
  if (window.electronAPI && window.electronAPI.getBestiarySync) {
    window.electronAPI.getBestiarySync().then((templates) => {
      remoteCreatures = Array.isArray(templates) ? templates : [];
      renderIfActive();
    });
  }

  // ---------------------------------------------------------------------
  // Package support (paired mode only) - expand/collapse + drag-and-drop
  // ---------------------------------------------------------------------
  // Mirrors IT's own package UI one for one (see its app.js "Bestiary
  // drag-and-drop" section) - expandedPackageIds/draggedTemplateId/
  // draggedFromPackageId are BT's own local copies of the exact same
  // state IT itself keeps, used only to drive BT's own rendering and
  // drag feedback. BT never mutates remoteCreatures directly for any
  // of this though - every actual change (reorder, add/remove
  // membership) is sent to IT as a request and only takes effect once
  // the next real bestiary-sync push reflects it, same as create/
  // delete already do.
  const expandedPackageIds = new Set(); // pure UI state, not persisted - matches IT's own "packages always start collapsed on reload"
  let draggedTemplateId = null;
  let draggedFromPackageId = null; // set only when the drag started on a NESTED package-member card, not a top-level one

  function togglePackageExpand(packageId) {
    if (expandedPackageIds.has(packageId)) expandedPackageIds.delete(packageId);
    else expandedPackageIds.add(packageId);
    renderSpawnTab();
    // Symmetric per spec - IT's own view of this same package flips
    // open/closed too, without focusing/puppeting its window, so a DM
    // who alt-tabs into IT directly mid-session sees the same state.
    if (window.electronAPI && window.electronAPI.requestToggleExpand) {
      window.electronAPI.requestToggleExpand(packageId);
    }
  }

  // Top-level drag-to-reorder - mirrors makeCardDraggable exactly, just
  // sending a request instead of splicing a local array directly.
  function wireDraggableTopLevelCard(cardEl, templateId) {
    cardEl.addEventListener('dragstart', (e) => {
      draggedTemplateId = templateId;
      draggedFromPackageId = null;
      e.dataTransfer.effectAllowed = 'move';
      cardEl.classList.add('dragging');
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggedTemplateId = null;
      sideScrollEl.querySelectorAll('.spawn-creature-card').forEach((c) => {
        c.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    });
    cardEl.addEventListener('dragover', (e) => {
      if (!draggedTemplateId || draggedTemplateId === templateId || draggedFromPackageId) return;
      e.preventDefault(); // required for drop to actually fire
      const rect = cardEl.getBoundingClientRect();
      const isTopHalf = (e.clientY - rect.top) < rect.height / 2;
      cardEl.classList.toggle('drag-over-top', isTopHalf);
      cardEl.classList.toggle('drag-over-bottom', !isTopHalf);
    });
    cardEl.addEventListener('dragleave', () => {
      cardEl.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    cardEl.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggedTemplateId || draggedTemplateId === templateId || draggedFromPackageId) return;
      const insertBefore = cardEl.classList.contains('drag-over-top');
      if (window.electronAPI && window.electronAPI.requestReorderTemplate) {
        window.electronAPI.requestReorderTemplate(draggedTemplateId, templateId, insertBefore);
      }
    });
  }

  // A nested package-member card's drag - lightweight, same as IT's own
  // buildCreatureCard nested branch: it only announces that a
  // member-drag started and which package it came from. What actually
  // happens on drop is entirely driven by wirePackageDropTarget (landed
  // in some package's member list) and/or the sideScrollEl-level
  // listener below (landed anywhere else - removes it from its origin
  // package). Both can fire off the same native drop event via
  // bubbling, exactly as they do in IT, which is what lets dragging a
  // member from one open package straight into another's folder read
  // as a single move rather than needing its own special case.
  function wireDraggableMemberCard(cardEl, templateId, packageId) {
    cardEl.addEventListener('dragstart', (e) => {
      draggedTemplateId = templateId;
      draggedFromPackageId = packageId;
      e.dataTransfer.effectAllowed = 'move';
      cardEl.classList.add('dragging');
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggedTemplateId = null;
      draggedFromPackageId = null;
    });
  }

  // Makes an expanded package's nested-member container a drop target -
  // mirrors makePackageDropTarget exactly, using remoteCreatures (BT's
  // own synced copy of IT's templates) for the same isPackage/already-
  // a-member checks IT itself does against its real array.
  function wirePackageDropTarget(containerEl, pkg) {
    function draggedIsValid() {
      if (!draggedTemplateId) return false;
      const dragged = remoteCreatures.find((t) => t.id === draggedTemplateId);
      if (!dragged || dragged.isPackage) return false; // can't nest a package inside a package
      return !pkg.members.some((m) => m.templateId === draggedTemplateId); // already a member of THIS package - nothing to do
    }
    containerEl.addEventListener('dragover', (e) => {
      if (!draggedIsValid()) return;
      e.preventDefault();
      containerEl.classList.add('spawn-package-drop-target-active');
    });
    containerEl.addEventListener('dragleave', (e) => {
      if (e.target === containerEl) containerEl.classList.remove('spawn-package-drop-target-active');
    });
    containerEl.addEventListener('drop', (e) => {
      containerEl.classList.remove('spawn-package-drop-target-active');
      if (!draggedIsValid()) return;
      e.preventDefault();
      if (window.electronAPI && window.electronAPI.requestAddToPackage) {
        window.electronAPI.requestAddToPackage(draggedTemplateId, pkg.id);
      }
    });
  }

  // Dragging a nested member card out of its own folder, dropped
  // anywhere else in the Bestiary, removes it from that package -
  // mirrors the bestiaryScrollEl-level handler in IT exactly, attached
  // once here (sideScrollEl itself persists across renders; only its
  // innerHTML gets replaced) rather than re-attached on every render.
  // Only ever does anything mid-drag of a card this tab itself
  // rendered, so it's harmless for this to technically also exist
  // while some other side tab is active.
  sideScrollEl.addEventListener('dragover', (e) => {
    if (!draggedFromPackageId) return;
    e.preventDefault();
  });
  sideScrollEl.addEventListener('drop', (e) => {
    if (!draggedFromPackageId) return;
    const landedContainer = e.target.closest ? e.target.closest('[data-package-drop-target]') : null;
    if (landedContainer && landedContainer.dataset.packageDropTarget === draggedFromPackageId) {
      return; // dropped back into the same folder it came from - no-op
    }
    e.preventDefault();
    if (window.electronAPI && window.electronAPI.requestRemoveFromPackage) {
      window.electronAPI.requestRemoveFromPackage(draggedTemplateId, draggedFromPackageId);
    }
  });

  // ---------------------------------------------------------------------
  // Creature tray - clicking a card's body loads it into the tray (see
  // tray.js). Attached once, same as the drag-out-of-package listeners
  // above, rather than re-wired on every render. Skips anything that
  // started on a button (Edit/Delete/the package toggle all live inside
  // the card itself and don't stopPropagation their own clicks) so
  // those keep doing what they already do instead of ALSO spawning a
  // token.
  sideScrollEl.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const card = e.target.closest('.spawn-creature-card');
    if (!card) return;

    if (itConnected) {
      // Works for both a plain creature and a package's own top-level
      // card (data-drag-top covers both) - IT resolves which one it is
      // and either spawns a single entity or deploys the whole package
      // (see remoteSpawnEntity), the same as a real click on IT's own
      // Bestiary card would. remoteCreatures isn't touched here; the
      // tray/map only ever update once the entity-sync push confirms
      // what actually got loaded (see tray.js's syncFromEntities).
      const templateId = card.dataset.dragTop || card.dataset.dragMember;
      if (templateId && window.electronAPI && window.electronAPI.requestSpawnEntity) {
        window.electronAPI.requestSpawnEntity(templateId);
      }
      return;
    }

    const creature = bestiaryCreatures.find((c) => c.id === card.dataset.creatureId);
    if (creature && window.CreatureTray) window.CreatureTray.spawnLocal(creature);
  });

  function cryptoRandomId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // Fallback for older Electron/Chromium builds without randomUUID -
    // not cryptographically strong, but only needs to be unique within
    // one DM's own local bestiary, not globally.
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function clampRange(value, min, max, fallback) {
    if (Number.isNaN(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------
  // Quick-create/edit form state - one shared form for both. Unlike the
  // first pass, an edit doesn't pop a form up somewhere else in the
  // panel - see renderSpawnTab below, which renders this form IN PLACE
  // of whichever card is being edited (formEditId), turning that exact
  // card into its own edit state rather than opening what reads as an
  // unrelated new one.
  // ---------------------------------------------------------------------
  let formOpen = false;
  let formMode = 'create'; // 'create' | 'edit'
  let formEditId = null; // set while editing - which existing card the form replaces
  let formName = '';
  let formHp = '';
  let formInitBonus = ''; // only used in paired mode's full form - the local form never shows this field

  function openCreateForm() {
    if (itConnected) {
      // Paired: the cap that matters is IT's own MAX_TEMPLATES, enforced
      // on IT's side when the message actually arrives - nothing local
      // to check against here since remoteCreatures is just a mirror.
      formOpen = true;
      formMode = 'create';
      formEditId = null;
      formName = '';
      formHp = String(HP_DEFAULT);
      formInitBonus = String(INIT_DEFAULT);
      renderSpawnTab();
      return;
    }
    if (bestiaryCreatures.length >= MAX_CREATURES) return; // "+ New" is disabled at the cap - see renderSpawnTab
    formOpen = true;
    formMode = 'create';
    formEditId = null;
    formName = '';
    formHp = String(HP_DEFAULT);
    renderSpawnTab();
  }
  function openEditForm(creature) {
    // Standalone-only - paired mode's Edit pencil never reaches this
    // (it hands off to IT's real Advanced editor instead, see
    // wireSpawnTab's paired branch), so this can stay exactly what it
    // was.
    formOpen = true;
    formMode = 'edit';
    formEditId = creature.id;
    formName = creature.name;
    formHp = String(creature.hp);
    renderSpawnTab();
  }
  function closeForm() {
    formOpen = false;
    renderSpawnTab();
  }
  function submitForm() {
    const name = formName.trim().slice(0, NAME_MAX_LENGTH);
    if (!name) return; // Name is the one required field - Save is a no-op without it, same as IT's own quick-create form

    if (itConnected) {
      // Paired create only - paired mode never reaches the edit branch
      // (see openEditForm's comment above). Sent over the wire and
      // NOT applied locally: remoteCreatures only ever changes via the
      // next real bestiary-sync push from IT, so this stays a single
      // source of truth instead of a local guess that could drift from
      // what IT actually saved (e.g. if IT's own cap rejects it).
      const initBonus = clampRange(parseInt(formInitBonus, 10), INIT_MIN, INIT_MAX, INIT_DEFAULT);
      const hp = clampRange(parseInt(formHp, 10), HP_MIN, HP_MAX, HP_DEFAULT);
      if (window.electronAPI && window.electronAPI.requestCreateTemplate) {
        window.electronAPI.requestCreateTemplate({ name, initBonus, hp });
      }
      formOpen = false;
      renderSpawnTab();
      return;
    }

    const hp = clampRange(parseInt(formHp, 10), HP_MIN, HP_MAX, HP_DEFAULT);
    if (formMode === 'edit') {
      const creature = bestiaryCreatures.find((c) => c.id === formEditId);
      if (creature) { creature.name = name; creature.hp = hp; }
    } else {
      if (bestiaryCreatures.length >= MAX_CREATURES) return;
      bestiaryCreatures.push({ id: cryptoRandomId(), name, hp });
    }
    persistBestiary();
    formOpen = false;
    renderSpawnTab();
  }
  // Paired "+ New" form's Advanced link - hands the in-progress draft
  // off to IT's real Advanced editor the same way IT's own quick-create
  // form's Advanced button does, just crossing the wire first (see
  // IT's onRemoteOpen 'advanced-create' handling). This is the one
  // path in paired mode that DOES puppet the window - unlike the plain
  // Save above, which saves silently in the background.
  function submitFormToAdvanced() {
    const name = formName.trim().slice(0, NAME_MAX_LENGTH);
    const initBonus = clampRange(parseInt(formInitBonus, 10), INIT_MIN, INIT_MAX, INIT_DEFAULT);
    const hp = clampRange(parseInt(formHp, 10), HP_MIN, HP_MAX, HP_DEFAULT);
    if (window.electronAPI && window.electronAPI.requestOpenAdvancedCreate) {
      window.electronAPI.requestOpenAdvancedCreate({ name, initBonus, hp });
    }
    formOpen = false;
    renderSpawnTab();
  }
  function removeCreature(id) {
    // Standalone-only, per FEATURE_KIND's own case (a): the local
    // Bestiary is what this whole function operates on, and paired
    // mode's delete button never calls it (see wireSpawnTab's paired
    // branch, which sends requestDeleteTemplate directly instead).
    bestiaryCreatures = bestiaryCreatures.filter((c) => c.id !== id);
    persistBestiary();
    renderSpawnTab();
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  // Name and HP share one row - BT's sidebar (312px) has real room for
  // it, unlike IT's narrower 260px one where HP sits in its own row
  // below Name. formIdAttr distinguishes the two live instances of this
  // markup (the standalone create-form's ids vs. an in-place edit's)
  // so wireSpawnTab can find the right one regardless of which is open.
  function renderCreatureForm() {
    // Paired mode gets IT's actual quick-create form, scaled up to BT's
    // wider sidebar the same way the local form already is (Name/HP on
    // one row) but otherwise unabridged: Init bonus field and the
    // "Advanced »" link both appear, matching IT's own #statBlockForm
    // exactly in substance. The local (standalone) form stays the
    // simplified Name+HP-only version it always was.
    if (itConnected) {
      return `
        <form class="spawn-creature-form" id="spawnCreatureForm">
          <input type="text" id="spawnFormName" class="spawn-form-name-input" placeholder="Name (e.g. Goblin)" maxlength="${NAME_MAX_LENGTH}" value="${escapeHtml(formName)}" required />
          <div class="spawn-form-fields">
            <label class="spawn-form-init-field">Init bonus
              <input type="number" id="spawnFormInitBonus" value="${escapeHtml(formInitBonus)}" step="1" min="${INIT_MIN}" max="${INIT_MAX}" />
            </label>
            <label class="spawn-form-hp-field">HP
              <input type="number" id="spawnFormHp" value="${escapeHtml(formHp)}" min="${HP_MIN}" max="${HP_MAX}" required />
            </label>
          </div>
          <div class="spawn-form-row">
            <button type="submit" class="spawn-btn-primary">Save</button>
            <button type="button" class="spawn-btn-ghost" id="spawnFormCancelBtn">Cancel</button>
          </div>
          <button type="button" class="spawn-btn-link" id="spawnFormAdvancedBtn">Advanced &raquo;</button>
        </form>
      `;
    }
    return `
      <form class="spawn-creature-form" id="spawnCreatureForm">
        <div class="spawn-form-fields">
          <input type="text" id="spawnFormName" class="spawn-form-name-input" placeholder="Name (e.g. Goblin)" maxlength="${NAME_MAX_LENGTH}" value="${escapeHtml(formName)}" required />
          <label class="spawn-form-hp-field">HP
            <input type="number" id="spawnFormHp" value="${escapeHtml(formHp)}" min="${HP_MIN}" max="${HP_MAX}" required />
          </label>
        </div>
        <div class="spawn-form-row">
          <button type="submit" class="spawn-btn-primary">Save</button>
          <button type="button" class="spawn-btn-ghost" id="spawnFormCancelBtn">Cancel</button>
        </div>
      </form>
    `;
  }

  function renderCreatureCard(c) {
    // Standalone-only now - paired mode's cards (plain/package/member)
    // are built by the renderRemote*/computePackageMemberIds family
    // below instead, since packages need quite different markup
    // alongside the plain-creature case this still handles. Being
    // edited right now - the form takes this exact card's place in the
    // list instead of opening anywhere else, so editing always reads
    // as "this card is now editable," not "a new card appeared."
    if (formOpen && formMode === 'edit' && formEditId === c.id) {
      return renderCreatureForm();
    }
    return `
      <div class="spawn-creature-card" data-creature-id="${c.id}">
        <span class="spawn-creature-name">${escapeHtml(c.name)}</span>
        <span class="spawn-creature-meta">${c.hp} HP</span>
        <button type="button" class="spawn-creature-edit" data-edit-creature="${c.id}" title="Edit this creature">&#9998;</button>
        <button type="button" class="spawn-creature-delete" data-remove-creature="${c.id}" title="Delete this creature">&times;</button>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Paired-mode card rendering (packages included)
  // ---------------------------------------------------------------------
  // Mirrors IT's own renderStatBlocks/buildCreatureCard split exactly:
  // any template that's a member of some package is hidden from the
  // top-level list and only ever shown nested under its owning
  // package's expand toggle - see IT's own comment on this same logic
  // ("this is what actually fixes 'building a package dumps everything
  // into the Bestiary'"). remoteCreatures already carries everything
  // needed to compute this the same way IT does, since
  // syncBestiaryToBattleTracker() now sends packages (with membership
  // references) alongside the plain creatures.
  function computePackageMemberIds(list) {
    const ids = new Set();
    for (const t of list) {
      if (t.isPackage) {
        for (const m of t.members) ids.add(m.templateId);
      }
    }
    return ids;
  }

  function renderRemoteCard(t) {
    const meta = `Init ${formatMod(t.initBonus)} &nbsp;&middot;&nbsp; ${t.hp} HP`;
    return `
      <div class="spawn-creature-card" data-drag-top="${t.id}" draggable="true">
        <span class="spawn-creature-name">${escapeHtml(t.name)}</span>
        <span class="spawn-creature-meta">${meta}</span>
        <button type="button" class="spawn-creature-edit" data-edit-creature="${t.id}" title="Edit this creature">&#9998;</button>
        <button type="button" class="spawn-creature-delete" data-remove-creature="${t.id}" title="Delete this creature">&times;</button>
      </div>
    `;
  }

  function renderRemoteMemberCard(memberTemplate, packageId, quantity) {
    const quantityBadge = quantity > 1 ? ` &nbsp;&middot;&nbsp; ×${quantity}` : '';
    const meta = `Init ${formatMod(memberTemplate.initBonus)} &nbsp;&middot;&nbsp; ${memberTemplate.hp} HP${quantityBadge}`;
    return `
      <div class="spawn-creature-card spawn-package-member-card" data-drag-member="${memberTemplate.id}" data-member-package="${packageId}" draggable="true">
        <span class="spawn-creature-name">${escapeHtml(memberTemplate.name)}</span>
        <span class="spawn-creature-meta">${meta}</span>
        <button type="button" class="spawn-creature-edit" data-edit-creature="${memberTemplate.id}" title="Edit this creature">&#9998;</button>
        <button type="button" class="spawn-creature-delete" data-remove-creature="${memberTemplate.id}" title="Delete this creature (also removes it from the package)">&times;</button>
      </div>
    `;
  }

  function renderRemotePackageCard(pkg, list) {
    const totalCount = pkg.members.reduce((sum, m) => sum + m.quantity, 0);
    const isExpanded = expandedPackageIds.has(pkg.id);
    let membersHtml = '';
    if (isExpanded) {
      membersHtml = pkg.members.map((m) => {
        const memberTemplate = list.find((x) => x.id === m.templateId);
        if (!memberTemplate) return ''; // deleted since being added - just skip it, same as IT's own expanded view does
        return renderRemoteMemberCard(memberTemplate, pkg.id, m.quantity);
      }).join('');
    }
    return `
      <div class="spawn-creature-card spawn-package-card" data-drag-top="${pkg.id}" draggable="true">
        <span class="spawn-creature-name">&#128193; ${escapeHtml(pkg.name || 'Unnamed Package')}</span>
        <button type="button" class="spawn-package-toggle" data-toggle-package="${pkg.id}" title="Show/hide the creatures in this package">
          <svg class="spawn-package-chevron${isExpanded ? ' expanded' : ''}" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
            <path d="M25,38 L50,62 L75,38" />
          </svg>
          <span>${totalCount} creature${totalCount === 1 ? '' : 's'}</span>
        </button>
        <button type="button" class="spawn-creature-edit" data-edit-package="${pkg.id}" title="Edit this package">&#9998;</button>
        <button type="button" class="spawn-creature-delete" data-delete-package="${pkg.id}" title="Delete this package">&times;</button>
      </div>
      ${isExpanded ? `<div class="spawn-package-member-list" data-package-drop-target="${pkg.id}">${membersHtml}</div>` : ''}
    `;
  }

  function renderRemoteTopLevelList(list) {
    const memberIds = computePackageMemberIds(list);
    const topLevel = list.filter((t) => !memberIds.has(t.id));
    return topLevel.map((t) => (t.isPackage ? renderRemotePackageCard(t, list) : renderRemoteCard(t))).join('');
  }

  function renderSpawnTab() {
    const creatures = itConnected ? remoteCreatures : bestiaryCreatures;
    // Paired mode's own cap is IT's, enforced on IT's side - "+ New"
    // only disables locally while a form is already open, same as it
    // always allowed up to MAX_CREATURES-1 to still open the form to
    // find out. Kept simple rather than trying to mirror IT's exact
    // count, which BT only ever sees a snapshot of anyway.
    const atCap = !itConnected && bestiaryCreatures.length >= MAX_CREATURES;
    const creating = formOpen && formMode === 'create';
    const cards = itConnected ? renderRemoteTopLevelList(remoteCreatures) : bestiaryCreatures.map(renderCreatureCard).join('');
    const empty = (!formOpen && creatures.length === 0)
      ? '<p class="menu-placeholder">No stat blocks yet.</p>'
      : '';

    // Import/Package only exist once IT is actually driving this tab -
    // standalone BT has no bundled 5e data of its own to import from,
    // and no package concept, so these simply aren't in the DOM at all
    // until paired (rather than present-but-disabled).
    const headerBtns = itConnected ? `
      <button type="button" class="spawn-icon-btn" id="spawnImportBtn" title="Import a creature from Initiative Tracker's bundled 5e bestiary">
        <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
          <path d="M50,15 L50,65 M28,43 L50,65 L72,43 M20,80 L80,80" />
        </svg>
      </button>
      <button type="button" class="spawn-icon-btn" id="spawnPackageBtn" title="Build a package - a group of creatures that deploy together">
        <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12,32 L12,78 L88,78 L88,32 L55,32 L47,20 L12,20 Z" />
        </svg>
      </button>
      <button type="button" class="spawn-new-btn" id="spawnNewBtn" title="Save a new creature"${formOpen ? ' disabled' : ''}>+ New</button>
    ` : `
      <button type="button" class="spawn-new-btn" id="spawnNewBtn" title="${atCap ? `The Bestiary is full (max ${MAX_CREATURES})` : 'Save a new creature'}"${(formOpen || atCap) ? ' disabled' : ''}>+ New</button>
    `;

    // A brand-new creature has no existing card to become, so its form
    // goes at the top of the list (the one place that's never mistaken
    // for replacing something already there) - an in-place edit's form
    // is already handled per-card above, inside `cards`.
    sideScrollEl.innerHTML = `
      <div class="settings-section-header draw-section-header-first spawn-header">
        <h4>Bestiary</h4>
        <div class="spawn-header-btns">${headerBtns}</div>
      </div>
      <div class="spawn-creature-list">
        ${creating ? renderCreatureForm() : ''}
        ${cards}
        ${empty}
      </div>
    `;

    wireSpawnTab();
  }

  function wireSpawnTab() {
    const newBtn = document.getElementById('spawnNewBtn');
    if (newBtn) newBtn.addEventListener('click', openCreateForm);

    // Import/Package only exist in the DOM while paired (see
    // renderSpawnTab) - each one asks BT's main process to puppet IT's
    // window and open the matching real modal there. No local handling
    // beyond that: IT's own modal flow does the actual work, and the
    // next bestiary-sync push reflects whatever came out of it.
    const importBtn = document.getElementById('spawnImportBtn');
    if (importBtn) importBtn.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.requestOpenImport) window.electronAPI.requestOpenImport();
    });
    const packageBtn = document.getElementById('spawnPackageBtn');
    if (packageBtn) packageBtn.addEventListener('click', () => {
      if (window.electronAPI && window.electronAPI.requestOpenPackage) window.electronAPI.requestOpenPackage();
    });

    sideScrollEl.querySelectorAll('[data-remove-creature]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (itConnected) {
          // Sent directly, no window puppeting - IT has no modal of
          // its own for a plain top-level delete either, so there's
          // nothing to focus IT for. remoteCreatures isn't touched
          // here; the next bestiary-sync push (fired from IT's own
          // saveTemplates choke point) is what actually removes the
          // card.
          if (window.electronAPI && window.electronAPI.requestDeleteTemplate) {
            window.electronAPI.requestDeleteTemplate(btn.dataset.removeCreature);
          }
          return;
        }
        removeCreature(btn.dataset.removeCreature);
      });
    });
    sideScrollEl.querySelectorAll('[data-edit-creature]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (itConnected) {
          // Puppets IT's window open to that creature's real Advanced
          // editor, rather than turning this card into a local edit
          // form - there IS no local edit state in paired mode.
          if (window.electronAPI && window.electronAPI.requestOpenEditTemplate) {
            window.electronAPI.requestOpenEditTemplate(btn.dataset.editCreature);
          }
          return;
        }
        const creature = bestiaryCreatures.find((c) => c.id === btn.dataset.editCreature);
        if (creature) openEditForm(creature);
      });
    });

    // A package's own Edit button - puppets IT's window open to the
    // real package-membership editor (openPackageEditModal), same
    // focus/refocus mechanics as a plain creature's Edit pencil above,
    // just a different modal on IT's end. Full symmetry with IT's own
    // Bestiary: every button BT shows now has a real counterpart there.
    sideScrollEl.querySelectorAll('[data-edit-package]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (window.electronAPI && window.electronAPI.requestOpenEditPackage) {
          window.electronAPI.requestOpenEditPackage(btn.dataset.editPackage);
        }
      });
    });

    // A package's own Delete button is NOT the same no-focus path a
    // plain creature's delete takes (see [data-remove-creature] above) -
    // IT has a real confirm prompt for deleting a package (contents-or-
    // folder-only), so this puppets the window open to it instead, and
    // BT refocuses the instant a choice is made there (same mechanics
    // as Edit/Import/Package - see IT's hidePackageDeleteModal).
    sideScrollEl.querySelectorAll('[data-delete-package]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (window.electronAPI && window.electronAPI.requestOpenDeletePackage) {
          window.electronAPI.requestOpenDeletePackage(btn.dataset.deletePackage);
        }
      });
    });

    // Package expand/collapse + drag-and-drop - all paired-mode only,
    // since none of these elements exist in the DOM while standalone
    // (see renderRemoteTopLevelList/renderRemotePackageCard, only ever
    // called when itConnected).
    sideScrollEl.querySelectorAll('[data-toggle-package]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // matches IT's own toggle button - don't let this bubble into anything the card itself might listen for
        togglePackageExpand(btn.dataset.togglePackage);
      });
    });
    sideScrollEl.querySelectorAll('[data-drag-top]').forEach((el) => {
      wireDraggableTopLevelCard(el, el.dataset.dragTop);
    });
    sideScrollEl.querySelectorAll('[data-drag-member]').forEach((el) => {
      wireDraggableMemberCard(el, el.dataset.dragMember, el.dataset.memberPackage);
    });
    sideScrollEl.querySelectorAll('[data-package-drop-target]').forEach((el) => {
      const pkg = remoteCreatures.find((t) => t.id === el.dataset.packageDropTarget && t.isPackage);
      if (pkg) wirePackageDropTarget(el, pkg);
    });

    // Only one <form> is ever in the DOM at a time (create's own, at
    // the top of the list, OR one card's in-place edit form) - same
    // ids either way, so this wiring doesn't need to know which case
    // it is.
    const formEl = document.getElementById('spawnCreatureForm');
    const nameInput = document.getElementById('spawnFormName');
    const initInput = document.getElementById('spawnFormInitBonus'); // only present in the paired full form
    const hpInput = document.getElementById('spawnFormHp');
    const cancelBtn = document.getElementById('spawnFormCancelBtn');
    const advancedBtn = document.getElementById('spawnFormAdvancedBtn'); // only present in the paired full form

    if (nameInput) {
      nameInput.focus();
      nameInput.select();
      nameInput.addEventListener('input', () => { formName = nameInput.value; });
    }
    if (initInput) {
      initInput.addEventListener('input', () => { formInitBonus = initInput.value; });
    }
    if (hpInput) {
      hpInput.addEventListener('input', () => { formHp = hpInput.value; });
    }
    if (formEl) {
      formEl.addEventListener('submit', (e) => {
        e.preventDefault();
        submitForm();
      });
    }
    if (cancelBtn) cancelBtn.addEventListener('click', closeForm);
    if (advancedBtn) advancedBtn.addEventListener('click', submitFormToAdvanced);
  }

  // Registered the same way every other side tab's content is (see
  // app.js's setActiveSideTab) - Spawn has no header-left content of
  // its own (no tools to equip), so SideTabHeaderRenderers.spawn is
  // deliberately left unregistered; switching to Spawn clears the
  // header the same way any tab with nothing registered there already
  // does.
  window.SideTabRenderers = window.SideTabRenderers || {};
  window.SideTabRenderers.spawn = renderSpawnTab;
})();
