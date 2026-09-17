# Companion App Ecosystem — Developer Primer

Covers **two** apps now: **Initiative Tracker** (Sections 1-9, largely
written at the end of an earlier long session, still accurate) and
**Battle Tracker** (Section 9.5). BT went from "a design doc" to a
working app with walls/textures/tools/undo/a full color system in one
earlier session, then gained Logic pieces, texture rotation, a Select
tool (move/toggle already-placed items), and a full Wire system spanning
three separate creation surfaces (sidebar, header, right-click map menu)
across a long follow-up session/conversation, then gained three more
Logic piece types and a header icon fix in a September 2026 session that
also involved a full sandbox-reset recovery — **read Section 9.8 first,
before anything else, if you're picking this project up fresh** — it
covers a real incident where this project's entire working directory
came back completely pristine mid-continuity, with no git history to
recover from, and what that means for how you should treat "the code
currently on disk" going forward. **Section 9.5 is current as of
v0.4.0** - read it in full before touching BT code, not just the parts
that sound relevant, since several small but real bugs this last session
came from touching a piece without knowing about its interaction with
another (wire endpoint labels, the color picker's positioning
requirements, a hotkey whitelist that didn't know about a new tool).
Section 11 ("Working With This Person") and Section 9.7 ("Testing This
Sandbox — Lessons Learned") apply to both apps.

The person you're working with is **Benjamin Kaschalk** (GitHub:
`AlanTheSecond`, repos: `https://github.com/AlanTheSecond/Initiative-Tracker`
and presumably a sibling `Battle-Tracker` repo — confirm the remote before
assuming it exists/is pushed; IT's repo appears to be private, doesn't
turn up in web search, don't expect to reach it externally). He's a game
design major, not a programmer by background — that shows up in *how* he
specifies things (see "Working With This Person" at the end), and it's a
real asset, not something to route around.

This is a planned **companion-app ecosystem** (see the Roadmap section).
Whatever conversation you're in, check whether the person is asking about
one of these two apps specifically or about a *new* third app in the same
family — the architecture here is meant to be a template for those too.

---

## 1. What This Is (Initiative Tracker)

A portable Windows desktop app for running D&D 5e tabletop combat. Built with
Electron, ships as a single portable `.exe` (no installer, no registry
writes). No framework — plain HTML/CSS/JS, one big renderer file.

**Current version: v1.6.5.** Read this carefully before touching
`package.json` — the numbering has a real wrinkle. Mid-session, the version
was bumped automatically after every batch of work (1.6.1 → 1.6.2 → 1.6.3 →
1.7.0 → 1.7.1 → 1.8.0 → 1.8.1), the same habit as before. The person then
explicitly corrected this: those later jumps weren't authorized as "new
versions" in his eyes, and the next batch of work (a couple of real bugfixes
plus a Change Log feature) was to be called **1.6.5**, deliberately lower
than several already-built releases, with an explicit instruction: **do not
bump the version again without being told to.** Practically: 1.7.0 through
1.8.1 are real, already-built, already-verified releases that exist and were
handed over — this isn't a request to un-ship them — but the version counter
going forward should NOT auto-increment per work session the way it had
been. Treat every future batch of work as staying on whatever version number
is currently in `package.json` unless he says otherwise, even across
multiple rounds of fixes in the same or a later conversation.

Every past version's worth of features is still in the app; nothing has
been cut. At this size (~7,300 lines of JS, ~2,900 lines of CSS), the file
is long but not disorganized — sections are marked with
`// ---------------------------------------------------------------------`
banner comments, and a `grep -n "^// ---"` gives you a table of contents
(66 sections as of this writing).

### The Change Log gap — flag this to him if it comes up again
He asked for a persistent in-app Change Log (5e-Index-style collapsible
list, one entry per version — see Section 8-adjacent notes below for where
it lives in code) and then said the resulting version history was
"incorrect," expecting it to match a changelog he believed already existed
somewhere. **That prior changelog was never found.** Checked and confirmed
empty-handed: full git log on both the local clone and the real GitHub
remote (only 3 commits predate this project's Claude-assisted history at
all — "Add files via upload" x2 and one repo-layout fix, no incremental
trail for v1.0–v1.5), a filesystem-wide search for any CHANGELOG/HISTORY
file, this primer's own text (which only describes the state *at* v1.6.0,
not a version-by-version account), and a web search for the GitHub repo
itself (doesn't surface — likely private). If a real changelog exists, it
lives somewhere this sandbox can't currently reach (his own notes, a
private doc, something in the private repo directly). **Ask him directly
where it is before rebuilding `CHANGELOG_DATA` again** rather than
re-guessing — this was left unresolved at the end of this session.

## 2. Where Everything Lives

```
main.js                 Electron main process - window creation, single-
                         instance lock, save/load-encounter IPC, F11 fullscreen
preload.js               contextBridge - exposes ONLY saveEncounter()/loadEncounter()
                         to the renderer. Nothing else crosses the isolation
                         boundary; the renderer has no Node/fs access at all.
renderer/
  index.html              App shell + every modal's static HTML (~35 modals/
                          popups by now, including the package editor and the
                          ledger divider's context menu added this session).
                          Dynamic sub-content (Settings tab, 5e Index tab,
                          Change Log tab, Guide tab, package contents, etc.)
                          gets built as innerHTML strings from app.js instead.
  app.js                 Everything. ~7,300 lines, no framework, no build
                          step - it's the literal file that ships.
  style.css               ~2,900 lines. Dark "GM lamp-lit war-room" theme +
                          light mode via CSS custom properties.
  data/
    bestiary-5e-data.js    Bundled 5e reference library, ~2,089 creatures,
                          pre-processed once from a CSV export. Read-only at
                          runtime - never mutated, only merged with custom
                          content for display.
package.json             version (see the versioning note above before
                          touching this), electron-builder config (mac + win
                          targets)
README.md, LICENSE, .gitignore   Present, real, not placeholders
```

No `node_modules` or `dist` in the repo (gitignored). No test suite - this
app's "tests" are the manual verification workflow described in Section 6.

## 3. Architecture & Data Models

### Template (a Bestiary stat block)
```js
{ id, name, initBonus, hp, ac, speed, str/dex/con/int/wis/cha,
  creatureType, creatureSize, isUnique, reactions, legendaryActions,
  autoRollInitiative, skills[], features,
  saves: {str,dex,con,int,wis,cha},
  savesAuto: {str,dex,con,int,wis,cha},   // true = derived from ability mod, not hand-set
  initBonusAuto: bool,   // NEW this session - same idea as savesAuto, but for
                          // the one Init stat, tied to Dex specifically. See
                          // "Dex -> Init auto-link" below for the backward-
                          // compat gotcha - it deliberately does NOT default
                          // missing data to true the way savesAuto does.
  resistances: {acid,bludgeoning,...: 'V'|'N'|'R'|'I', [customContentId]: same},
  isPackage?: true, members?: [{templateId, quantity}] }   // see Section 8
```
Packages live in this SAME array, distinguished by `isPackage: true`. This
was a deliberate choice - it means the Bestiary sidebar's render loop
handles both uniformly with one filter, rather than needing a parallel list.

### Entity (a spawned instance in the live encounter)
```js
{ id, templateId, name, hp, maxHp, initBonus, initiativeTotal, tiebreak,
  spawnOrder, notes, tags[], reactionsRemaining, legendaryActionsRemaining,
  counters: {trackerId: currentValue} }
```
Entities reference templates by `templateId`. **This is load-bearing**:
`getEntityStatSource()` and friends assume `templates.find(t => t.id ===
entity.templateId)` always resolves. Anything that removes a template needs
to consider what happens to entities still referencing it (generally:
gracefully degrade, don't crash - see `defaultAdvancedFields()` fallback).

**`entity.id` is always numeric** (`nextEntityId++`, a module-level
counter), never a string — unlike `template.id`/`content.id`/etc., which are
always `cryptoRandomId()` strings. This distinction caused a real, shipped
bug this session (see Section 7, lesson on `getNextAwaiting`) — anything
that reads an id out of a DOM `dataset` attribute (always a string) and
compares it against `entity.id` needs an explicit `String(a) === String(b)`
comparison, not `===`, or the comparison silently never matches.

### Package (see Section 8 for the full design rationale)
A package is just a `Template` with `isPackage: true` and no real stat
fields - it's a grouping/deployment construct, not a creature.

### Custom Trackers (`customConditions`, key `initiative-tracker-custom-conditions`)
```js
// kind='tag': { id, name, kind:'tag', abbr, applyElement:bool, elementDamageType?, elementResist?:'V'|'R'|'I' }
// kind='counter': { id, name, kind:'counter', defaultValue:0-99, resetOnTurnStart:bool }
```
Lives in the Settings tab's data model but is now **rendered in the 5e
Index tab**, directly under Custom Content (moved there in v1.6 - see
`renderIndex5e()`, not the Settings-tab render function). If you're hunting
for where this UI lives and find it missing from Settings, that's why.

### Custom Content (`customContent`, key `initiative-tracker-custom-content`)
```js
{ id, name, type: 'Conditions'|'Damage Types'|'Creatures'|'Abilities and Skills',
  abbr?, desc?, ability?,
  isBatch?: true, creatureIds?: [contentId, ...] }   // Bulk Add CSV batches - see Section 8-adjacent notes below
```
`INDEX_SECTION_TYPES` is the single source of truth for the four category
names and their sort order.

### Custom Creature Data (`customCreatureData`, key `initiative-tracker-custom-creature-data`)
Full template-shaped stat blocks, keyed by Custom Content id. Independent of
the `templates` array - a custom creature survives deletion of whatever
Bestiary entry it was originally imported from. **Speed is always stored
canonically in feet**, converted to/from the display unit (`feet`/`spaces`)
only at the UI boundary. If you ever touch speed-related code, search for
`canonicalSpeed` first - there's an established conversion pattern used in
at least four places (single Custom Content add, Bulk Add, the advanced
editor's custom-creature edit path, `mapBestiaryEntryToTemplate`).

### Settings (`initiative-tracker-settings`)
```js
{ lightMode, speedUnit, autoRefreshReactions, settleInitiativeDisputes,
  focusHighestInitiative,
  calculateElements,
  ledgerMaskHeight,       // NEW - px height of the active-creature panel
                          // above the ledger divider, draggable, persisted
  ledgerDividerLocked }   // NEW - right-click the divider to toggle
```
`loadSettings()` does `{...defaults, ...JSON.parse(saved)}` - adding a new
setting is always safe for existing save files; they'll pick up the default
until the person actually changes it.

## 4. Key Shared Functions (the ones everything else depends on)

- **`getFullCreatureLibrary()`** - THE single source of truth for "every
  creature that exists" (bundled + custom, merged, alphabetized). **Cached**
  (`creatureLibraryCache`), invalidated via `invalidateCreatureLibraryCache()`
  - there are exactly 8 call sites that mutate `customCreatureData`, and all
  8 correctly invalidate. If you add a 9th, invalidate there too, or you'll
  reintroduce the exact bug this caching was built to avoid (keystroke-driven
  full library rebuild). Packages and package members are correctly excluded
  from this list (a package isn't a creature).
- **`mapBestiaryEntryToTemplate(entry)`** - converts a raw bestiary-shaped
  entry (`size`/`type`, not `creatureSize`/`creatureType`) into a real
  Template. Used by Import Creature, Import Encounter, Custom Content
  Creatures, Bulk Add, and the package-add flow (see Section 8) - if you're
  building ANYTHING that turns "a creature description" into "a real
  template," reuse this rather than reimplementing defaulting logic.
- **`templateMatchesSourceEntry(template, entry)`** - checks whether an
  existing template is identical to what re-importing its source would
  produce. Used to skip needless "overwrite?" prompts when nothing's
  actually changed. Only compares fields `mapBestiaryEntryToTemplate`
  actually derives - not `id`.
- **`isPackageDraftMode()`** - NEW. True for `encounterModalMode ===
  'package'` (the original build-a-package-from-scratch flow) OR
  `'package-add'` (adding to an already-open package via the Edit Package
  screen). Both share the same "no live spawn decision to make, so never
  show the disambiguation prompt" behavior — see Section 8's package-editing
  writeup for why this needed its own helper rather than reusing the
  original single-mode check.
- **`getNextAwaiting(awaiting)`** - NEW. Resolves which awaiting entity the
  roll bar should actually offer: the DM's explicit pick from the drop-up
  (`selectedAwaitingId`, compared via `String(...)` — see the id-type note
  above) if still valid, else `awaiting[0]` like always. `submitRoll()` and
  `updateRollBar()` both go through this now instead of hardcoding `awaiting[0]`.
- **`scrollActiveRowIntoPlace({smooth})`** - NEW, pulled out of
  `renderLedger` so a divider drag or window resize can reposition the
  active row without a full ledger re-render. `smooth:false` (drag/resize)
  uses `ledgerEl.scrollTo({behavior:'instant'})`, NOT a plain `scrollTop =`
  assignment — `.ledger`'s own `scroll-behavior:smooth` CSS applies to
  *every* scroll operation in Chromium, including direct property
  assignment, not just `.scrollTo()` calls. This cost real debugging time;
  see Section 7.
- **`computeMaxMaskHeight()`** / **`MIN_MASK_HEIGHT`** - NEW. Bounds for the
  ledger divider's drag range. Min is the fixed original default (220px).
  Max is computed live from whichever row is actually on screen (falls back
  to a constant if the ledger's empty), specifically subtracting BOTH the
  divider's own height AND `.ledger`'s own top/bottom padding — omitting the
  padding subtraction was a real, shipped-then-caught bug this session (see
  Section 7).
- **`finalizeInitiativeRoll(entity, rawRoll)`** - the one function every
  initiative-rolling path funnels through (manual entry, auto-roll on
  import/deploy, the calculator's own initiative mode). Handles the "snap
  active turn to whoever just out-rolled the current active creature"
  behavior, gated by `settings.focusHighestInitiative`. Returns
  `justActivated` (bool) - callers use this to decide whether to scroll the
  ledger to the new active row.
- **`deployPackage(pkg)`** - resolves each package member against the LIVE
  `templates` array at the moment of deployment (never a cached snapshot),
  so editing a creature after building a package is correctly reflected the
  next time it's deployed.
- **`buildCreatureCard(t, {nested, quantity, packageId})`** - shared between
  top-level Bestiary cards and a package's expanded nested-member cards.
  `nested` controls whether the card is draggable for reordering (top-level
  only) vs. draggable for package-membership purposes (nested only, via
  `draggedFromPackageId` — see `makePackageDropTarget` and the
  `.bestiary-scroll`-level drop handler for pulling a member out of a
  folder). `packageId` (new this session) tags which package a nested
  card's membership-drag originated from.

## 5. UI/CSS Conventions (established rules, not suggestions)

- **No generic `.hidden { display:none }` utility exists on purpose.** Every
  individual visibility toggle gets its own scoped rule
  (`.calc-savingthrows-footer .hidden`, `#saveEffectMarkedFields.hidden`,
  etc.). This was a deliberate choice from early in the project; don't
  "fix" it by adding a generic utility class, it'll silently break things
  that rely on more specific rules winning.
- **z-index is tiered explicitly**, documented near the top of the relevant
  CSS block: base modals at 10-12, `#advancedModal`-style sidebar-triggered
  modals at 13, `#unsavedModal`/`#encounterImportModal`/`#packageEditModal`
  at 14, anything that can open ON TOP of one of those (including
  `#confirmModal`, now nested inside the package editor too) at 15.
  Transient, cursor-anchored popups that aren't part of the modal system at
  all (the ledger divider's right-click Lock menu, the awaiting-creature
  drop-up) sit at their own tier, 100, well above the modal stack rather
  than trying to slot into it. If you add a new modal that can be opened
  from within another modal, it needs a tier strictly above whatever it can
  appear over - **don't rely on DOM order** to break ties; that's fragile
  and has caused real bugs across this whole project.
- **Responsive layout uses CSS `@container` queries now, not just
  `flex-wrap` + a `min-width` floor.** The ledger's active-info panel
  (`.ledger-mask{container-type:inline-size}`) switches between side-by-side
  and stacked via a single `@container` breakpoint that drives BOTH the
  layout switch and the stacked-state sizing rules in one place. This
  replaced an earlier flex-wrap-based version specifically because two
  separate numbers (a flex `min-width` and an implicit wrap point) could
  drift apart; one named breakpoint can't. If you add more responsive
  panels, prefer this pattern over flex-wrap + a width floor.
- **A flex row's `align-items` default (`stretch`) is usually what you
  want when a row's boxes need to look uniform in height** — don't reach
  for `align-items: flex-start` + manual centering to "fix" a taller
  sibling; it very likely breaks alignment for every OTHER box in the row
  instead (see Section 7's stat-box saga — it took two attempts to get
  right, and the correct answer was to change nothing about alignment at
  all, just stop centering).
- **Palette**: `CUSTOM_TRACKER_COLORS` (20 hex values, avoids `#9b4fe0` and
  `#d97a26` since those are reserved for reaction/legendary dots).
  `tag-condition` (pink, `#c2477a`) = built-in AND custom Tag/Condition
  trackers AND Custom Content Conditions. `tag-custom` (teal) = Custom
  Tracker Element. Packages get a yellow/accent left-border treatment
  wherever they appear (Bestiary sidebar, Import Encounter's browse list).
- **Copyright-safe by construction**: the bundled bestiary data was built
  from a licensed CSV export, pre-processed once, never touched at runtime.
  Don't add features that reproduce copyrighted flavor text verbatim
  elsewhere in the app.

## 6. Build & Verification Workflow

This is the single most important section if you're about to touch code and
need to prove it works, not just assume it does. **Read the new subsection
at the end of this section (§6.5) before doing anything else** — it's a
direct response to this session running much slower than it needed to.

### The sandbox resets between conversations (and sometimes mid-conversation)
Check whether `/home/claude/work` (or wherever the project lives) still has
the files before assuming continuity. If it's gone: `git clone
https://github.com/AlanTheSecond/Initiative-Tracker.git` gets you the real,
current state - **more reliable than trusting any local zip**, since the
person may have pushed changes from their own machine since you last touched
it. (In practice this session, `origin/main` only ever had 3 commits the
whole time — nothing was ever pushed back upstream despite ~40 local commits
of work. If continuing this project, consider actually pushing, or at least
flagging to the person that the GitHub repo doesn't reflect any of this
session's work.) `npm install`, then Wine needs reinstalling if it's a
fresh sandbox:
```
dpkg --add-architecture i386
apt-get update -qq
apt-get install -y wine wine64 wine32 xvfb xdotool
```
(`wine32:i386` as a package name fails on this distro; use bare `wine32`.)

### The default Wine prefix (`~/.wine`) is fragile — don't delete it casually
If `~/.wine` ever gets deleted (e.g. during a disk-space cleanup pass) and
then implicitly re-created by a build, it can come back **broken** —
`electron-builder`'s `rcedit` step (which stamps the exe's version metadata)
will fail with `wine: could not load kernel32.dll, status c0000135`, and the
build never produces an exe. The fix isn't retrying — it's initializing a
**fresh, explicitly-architected prefix**:
```
WINEARCH=win64 WINEPREFIX=/tmp/wine-fresh-test wineboot --init
```
under a running Xvfb display. Once that succeeds, point every build/verify
command at that same `WINEPREFIX` explicitly rather than the default. Given
this, **don't `rm -rf ~/.wine` as part of routine disk cleanup** — clean
`dist/win-unpacked` and stray `.7z` intermediates instead, and only touch a
`WINEPREFIX` test directory (never the default one).

### Building the Windows exe
```
cd /path/to/project
rm -rf dist
nohup xvfb-run -a env WINEPREFIX=/tmp/wine-fresh-test WINEARCH=win64 npx electron-builder --win portable > /tmp/build.log 2>&1 &
```
Takes 4-8 minutes. See §6.5 below for how to poll this without wasting the
whole session rediscovering the same process-lifetime issue repeatedly.
Watch `/tmp/build.log` for `no space left`, `nsis error`, or `integrity` -
those are real failures; COM/OLE/NTLM/ALSA/X-connection/dbus noise during
Wine execution is normal and not a sign of anything wrong.

### Verifying the exe actually runs
```
export WINEPREFIX=/tmp/wine-fresh-test
cd dist
xvfb-run -a wine "InitiativeTracker X.X.X.exe" > /tmp/verify.log 2>&1 &
# then poll ps aux for the expected process types (see below) and
# grep the log for the same three failure strings
```
A real, healthy launch shows **four distinct process types** in `ps aux`
once it's fully up: the main `InitiativeTracker.exe`, one with
`--type=gpu-process`, one with `--type=utility --utility-sub-type=network...`,
and one with `--type=renderer`. Seeing all four, twice, a few seconds apart
(confirming they're stable, not crash-looping) plus a clean grep of the log
is the actual bar — don't chase more certainty than that.

### Disk management (critical, not optional)
Wine prefixes and `win-unpacked` dirs are large and accumulate fast. Clean
immediately after each verification, not in a batch at the end — this
session ran low on disk space (down to ~2-3GB free) more than once from
neglecting this:
```
pkill -f "InitiativeTracker X.X.X.exe"; pkill wineserver
rm -rf /tmp/wine-fresh-test   # only the TEST prefix, never the default ~/.wine setup itself, see above
rm -rf dist/win-unpacked
```
Check `df -h /` and keep at least ~3GB free.

### Actually seeing what you built
This sandbox can run the real app headlessly and take real screenshots, or
drive it directly via Chrome DevTools Protocol (CDP) — the latter is far
more reliable than simulated mouse events for anything beyond a single
click (see §6.5's CDP pattern). For screenshots specifically:
```
DISPLAY=:99 import -window root /tmp/screenshot.png    # ImageMagick
```
Then use the `view` tool on the PNG, or crop/zoom with `convert -crop WxH+X+Y
-resize 500% in.png out.png` for a close look at a small UI region. For
exact pixel measurements, prefer reading real computed values via CDP
(`getBoundingClientRect()`, `getComputedStyle()`) over eyeballing a
screenshot or scanning pixels — it's both faster and more precise, and lets
you assert on the actual number rather than a visual impression.

**What screenshots/pixel-measurement can't do**: simulated XTest mouse
events (`xdotool mousedown`/`mousemove`/`mouseup`) do not reliably trigger
genuine HTML5 drag-and-drop in Chromium. For a drag-to-reorder or
drag-into-folder feature, either simulate the underlying DOM events directly
via CDP (`new MouseEvent('mousedown'/'dragstart'/'drop', ...)`, dispatched
on the actual elements — this DOES work reliably for the app's own
JS-level drag handlers, since they're listening for these events directly,
not relying on native OS-level drag semantics) or verify the reorder logic
in isolation and be honest that the physical gesture itself is unverified.

### 6.5 — Keeping usage down and turning builds around faster
This session took meaningfully longer than it needed to, almost entirely
because of one recurring mistake, plus a few smaller ones. Internalize
these before starting work, not after rediscovering them three times.

**1. Every backgrounded process dies the instant a `bash_tool` call ends.**
This is the single biggest time sink this session had. `nohup`, `setsid`,
disowning, wrapping in a subshell `(cmd &)` — none of it matters. Xvfb,
Electron, a build running under `xvfb-run`, a Wine verification run — all
of it gets reaped the moment the tool call that launched it returns,
**even if the process reported a real PID and was confirmed alive with `ps`
in that same call.** The fix is not a smarter backgrounding technique — it's
architectural: **launch AND everything that depends on that process being
alive must happen inside ONE bash_tool call.** Concretely:
- Launching Xvfb+Electron in call N, then trying to run CDP commands
  against it in call N+1, will fail with `Connection refused` essentially
  every time. Don't do this.
- The correct shape for any "run the app and check something" task is one
  call that does: start Xvfb → sleep → start Electron → poll
  `http://127.0.0.1:9222/json` in a retry loop (Electron's startup time
  varies) → run the actual CDP test(s) → read results — all before that
  bash_tool call returns.
- Same applies to builds: launch `electron-builder` in the background, then
  **poll for completion with a loop inside that same call** (`for i in
  $(seq 1 30); do sleep 15; check-for-output-file-or-dead-pid; done`), not
  a fire-and-forget launch checked from a later call.
- This does mean individual `bash_tool` calls in this project can legitimately
  run for several minutes (a build alone takes 4-8). That's fine and
  expected — it's far faster in total than the alternative of losing the
  process and having to restart from a cold launch every single check.

**2. Match the test's realism to what you're actually trying to catch.**
A real, shipped bug this session (the awaiting-creature picker silently
doing nothing when a creature was selected) slipped through an entire
verification pass because the test data used to seed "awaiting entities"
was hand-constructed with `cryptoRandomId()` string ids, while real
entities (via `spawnEntity`/`createEntityFromTemplate`) always get numeric
ids. The string-vs-string comparison in the test happened to work by
coincidence, masking the actual numeric-vs-string bug in production. When
testing app logic — especially anything comparing ids, checking types, or
depending on a specific data shape — **construct test data through the
app's real creation path** (`spawnEntity(template)`, not a hand-rolled
object literal), or at minimum match the real shape exactly. A test that
takes a shortcut on data realism can pass while the real feature is broken.

**3. Don't chase pixel-perfect certainty on purely cosmetic changes.**
Several rounds this session were spent re-measuring and re-adjusting a
single CSS threshold value (the ledger's side-by-side/stacked breakpoint)
by a handful of pixels, more precisely than the person could actually
perceive or had asked for. For a visual/cosmetic tweak: one honest
measurement + screenshot is enough to ship. If it's slightly off, the
person reporting back "still wrapped on my machine" is a faster, cheaper
correction loop than trying to out-guess font/DPI/OS-chrome differences you
can't observe directly from this sandbox anyway. Reserve real verification
rigor (the kind in point 2 above) for actual logic bugs, not pixel tuning.

**4. Batch a working session's changes into ONE build, not one per fix.**
Don't rebuild and hand over an exe after every individual small fix within
the same round of work. Gather everything the person has asked for in a
given exchange, apply and verify all of it together in one running
instance, commit once, and build once. This project's git history has
several consecutive "bump to vX.X.X" commits from single small fixes that
should have been batched — each one cost a full 4-8 minute build cycle for
work that could have shipped together.

**5. Don't auto-bump the version.** See the note at the top of this
document — this was an explicit, corrected mistake this session. Stay on
whatever version is currently in `package.json` across a work session
unless told otherwise, even if that means several rounds of fixes all
still building as the same version number.

## 7. Hard-Won Lessons From This Project

These cost real time to learn. Don't relearn them the hard way.

1. **A fix verified pixel-perfect on this sandbox's Linux/Xvfb Chromium can
   still be wrong on the person's actual Windows machine.** Native `<select>`
   elements, font metrics, and available layout width all render measurably
   differently between the two. This has bitten multiple times: a
   hardcoded margin-top that measured perfectly here didn't survive on
   Windows; a scrollbar-elimination fix measured zero overflow here but
   "the slightest scroll" reported there; a responsive-layout breakpoint
   calibrated against this sandbox's exact rendered width was still
   triggering at the plain default window size on his real machine. The
   fix for the *pattern*: prefer structural CSS solutions (two elements
   governed by the literal same layout rule can't drift, regardless of
   platform) over measured pixel offsets, and when a pixel threshold is
   unavoidable, build in deliberate, generous safety margin rather than
   trusting an exact cross-platform match — and don't be surprised if it
   still needs one more round of adjustment from real-machine feedback.

2. **The flexbox `min-height: auto` gotcha is real and worth knowing by
   heart**: a flex item with `flex: 1` still won't shrink below its own
   content's natural height unless it also has `min-height: 0`. Bit a
   Saving Throws footer once (a locked height silently grew past its lock),
   and resurfaced this session in the ledger rework — `.ledger-wrap` and
   `.ledger` both needed explicit `min-height: 0` for the resizable-panel
   layout to actually let the ledger shrink/scroll instead of overflowing.

3. **Removing `z-index`/`position` from an element because "it's not doing
   anything visually anymore" can silently break unrelated JS.** Dropping
   `position: relative` from `.ledger` (no longer needed for stacking once
   the overlay-based layout was replaced with real panels) also silently
   broke every `offsetTop`-based scroll calculation for the ledger's rows —
   `offsetTop` resolves relative to the nearest *positioned* ancestor, which
   without `position: relative` on `.ledger` became `<body>` instead,
   throwing off `scrollActiveRowIntoPlace`'s math by however far down the
   page the ledger happened to sit. If an element's `position` is load-
   bearing for a reason OTHER than the one you're removing, keep it and
   update the comment instead of deleting it.

4. **`scroll-behavior: smooth` in CSS overrides *every* scroll operation on
   that element in Chromium, including a plain `element.scrollTop = x`
   assignment — not just `.scrollTo()` calls.** An "instant" reposition
   during a live drag gesture (deliberately non-smooth, to avoid visible
   animation lag on every mousemove tick) silently wasn't instant at all —
   reading `scrollTop` right back showed a stale, still-mid-animation value.
   The fix is `element.scrollTo({top, behavior: 'instant'})`, which is the
   one thing that actually overrides the CSS default when you need to.

5. **When centering a flex row's uneven-height children to "fix" one taller
   sibling, check what it does to the OTHER siblings before shipping it.**
   Adding `justify-content: center` to make a 2-child box (label + input)
   look nice inside a now-taller box (label + input + a new third element)
   seemed reasonable, but a shorter *group* centers to a different absolute
   position than a taller one — it made the shorter boxes' numbers sit
   visibly lower than their siblings, the opposite of "aligned." The
   working fix, on the second attempt, was to remove the centering
   entirely and go back to plain top-anchored block flow; the row's own
   default `align-items: stretch` was already handling uniform outer
   height correctly the whole time, and never needed help.

6. **A "container measures 400px wide" number developed empirically on
   this sandbox will not transfer exactly to a real Windows machine — plan
   for a follow-up correction, don't treat the first measurement as
   final.** See lesson 1; specifically bit the ledger's responsive
   breakpoint twice in a row this session (once discovered internally by
   re-measuring against the app's real default window size instead of an
   assumed one, once again after the person reported it still wrapping on
   his actual machine).

7. **A comparison between an id read from a DOM `dataset` attribute (always
   a string) and a data model's own id field needs to account for type,
   not just value.** See the `entity.id` note in Section 3 — this exact
   mismatch shipped as a real, completely silent bug (the awaiting-creature
   picker "selecting" a creature and closing the menu, but never actually
   changing who the roll applied to) because `===` never coerces, and
   because the test data used to verify it happened to use matching string
   ids by coincidence (see 6.5, lesson 2).

8. **Be upfront about what was actually verified versus assumed**,
   especially across a long session where it's tempting to say "confirmed
   working" out of momentum. The person has repeatedly asked for
   confirmation-by-real-check over confirmation-by-assertion, and it's the
   right instinct — vague confidence isn't the same as a passed check. This
   extends to being upfront about ambiguity: when a request has a genuinely
   unclear reading (see the changelog-renumbering question this session,
   which went unanswered when the person just said "continue"), make the
   least destructive/most easily-corrected assumption, proceed, and flag it
   clearly rather than silently picking a guess and hoping.

## 8. The Packages Feature (deep dive, updated this session)

**Core design decision, unchanged**: a package's members are
`{templateId, quantity}` references, resolved against the live `templates`
array at the moment they're needed (deploying, viewing, editing) - never a
frozen copy. Editing a creature's stats after it's part of a package is
automatically reflected the next time that package deploys, with zero extra
sync code, because the package never had its own copy to begin with.

**Editing a package no longer routes through the creation flow.** It used
to open the exact same picker used to build a package from scratch
(confusing, and the "which one should be loaded" disambiguation prompt from
spawn mode could leak in incorrectly). It now opens a dedicated screen
(`openPackageEditModal` / `#packageEditModal`): a name field, a list of
current members with `−`/`+` quantity controls, an **Add Creatures**
button (opens the original picker in a new `'package-add'` mode, purely
as a standalone creature-selector, not the whole-package builder), and
Save Package. Reducing a member's count to zero mirrors the nested-folder
delete exactly (same confirm prompt, same immediate global deletion — this
is the one part of the screen that's NOT staged behind Save Package, since
it's a real, permanent deletion the same way clicking delete on a nested
card already is).

**`'package-add'` mode's duplicate handling is genuinely different from the
original `'package'` mode's**, and this was a source of two real bugs this
session, both fixed:
- The disambiguation prompt ("which one should be loaded?") must never
  appear in either package mode — see `isPackageDraftMode()`. It initially
  leaked back in specifically through `resolveNameToSpawn`'s post-Keep-Both
  re-check, which only special-cased the literal string `'package'`, not
  `'package-add'`.
- **Keep Both**, when adding to an already-open package, must resolve to
  the FRESH copy it just created, not fall through the generic "prefer
  original, else first match" fallback the original whole-package flow
  uses — that fallback almost always resolved back to the pre-existing
  member instead of the newly-picked library copy, silently orphaning the
  new copy outside the package and just re-incrementing the existing
  member's count (looked exactly like "it duplicated the wrong creature").
  Fixed by resolving directly to the fresh copy's id at the two sites that
  create one (`onKeepBoth` in the overwrite-queue handler, and the
  multi-overwrite-queue's nothing-checked path), bypassing the generic
  resolver entirely for package-add.
- Templates created fresh via Add Creatures (a brand-new name, or a Keep
  Both copy) are real, permanent Bestiary entries the instant they're
  picked — but package membership itself is staged behind Save Package.
  If the edit session is discarded rather than saved, those freshly-created
  templates need to be rolled back too, or they're left behind as orphaned
  top-level Bestiary entries nothing ever committed to keeping. See
  `packageEditPendingNewTemplateIds` / `discardPendingPackageEditTemplates`
  — populated via a before/after snapshot of `templates` around each
  Add Creatures confirm, rolled back on a genuine discard, cleared
  (not rolled back) on a real save.

**Why members are hidden from the top-level Bestiary list, unchanged**:
`renderStatBlocks()` computes the set of all `templateId`s referenced by any
package's `members` and filters those out of the top-level render loop.
They're only shown nested under their owning package's expand toggle.
Delete a package (folder-only, keeping its contents) and the members simply
stop being filtered - no separate "un-hide" logic needed.

**Drag in/out of an open folder** (new this session): dragging a top-level
creature card into an expanded package's member list adds it as a member;
dragging a nested member card out removes it. Uses a second piece of drag
state, `draggedFromPackageId`, alongside the existing `draggedTemplateId`,
to distinguish "reordering the top-level list" drags from "moving package
membership" drags so the two don't cross-talk. The actual drop-target
listeners for "dragged OUT of a folder" are attached to `.bestiary-scroll`
(the real flex-filling scroll panel), not `#statBlockList` (which only
wraps tightly around its own content and stops well short of the panel's
visible bottom edge whenever the Bestiary is sparse) — this was a real,
reported usability bug (couldn't drag a creature out when there wasn't much
else in the Bestiary) fixed by moving the listener to the correct element.

**Bulk Add batches use a related-but-different pattern, unchanged**: a
batch's creatures get individual `customCreatureData` entries but only ONE
catalog row in the Custom Content list (`isBatch: true, creatureIds: [...]`).

## 9. The Ledger Layout (new section — resizable panel, responsive stacking)

The area above the compiler showing the active creature's full stat block
used to be a fixed-height absolute overlay with a padding hack on the
ledger below it to fake the reserved space. It's now two real, independent
flex-column panels — `#ledgerMask` (the active-info panel) and `#ledger`
(the compiler rows) — separated by a draggable divider (`#ledgerDivider`).

- **Resizable**: drag the amber divider to resize `#ledgerMask`. Bounds:
  `MIN_MASK_HEIGHT` (220px, the original fixed default — can't shrink
  below it) and `computeMaxMaskHeight()` (live-computed so the ledger below
  always keeps the active row fully visible plus roughly half a row on
  each side — see Section 4). Persisted via `settings.ledgerMaskHeight`.
- **Lockable**: right-click the divider for a Lock/Unlock popup
  (`#ledgerDividerMenu`) — locked disables both dragging (gated at the
  `mousedown` handler) and the hover highlight (`.locked` CSS class).
  Persisted via `settings.ledgerDividerLocked`.
- **Responsive**: General Info and Features sit side by side by default;
  Features stacks below General Info once the panel gets too narrow for
  both, via a `@container` query on `.ledger-mask` (see Section 5's CSS
  conventions note) rather than flex-wrap. The breakpoint is deliberately
  calibrated with real margin below the app's actual default window size
  (1200x780, see `main.js`) — this took two attempts to get right (see
  Section 7, lesson 6) and may still need a further nudge based on
  real-machine feedback.
- **Independently scrollable**: `.features-text` has its own scroll (with
  a thinner, 6px scrollbar) so General Info stays visible while reading a
  long stat block. Side by side, its scroll window matches General Info's
  height (and grows/shrinks with the divider). Stacked, it's clamped
  between 8.5 and 19.5 lines regardless of the divider's position (see the
  `@container` block in `style.css` for the exact px math from the panel's
  font-size/line-height).

## 9.5. Battle Tracker — Current State

Portable Electron app, same conventions as IT (single `.exe`, no
framework, `main.js`/`preload.js`/`renderer/`). **Version 0.4.0.** Repo at
`/home/claude/Battle-Tracker` in this sandbox — confirm whether a GitHub
remote exists/is current before assuming it's pushed anywhere.

### File layout
```
main.js, preload.js        Same pattern as IT - contextBridge isolation
pairing.js                  BT is the TCP CLIENT (IT is the server) - see
                             "Pairing" below
renderer/
  index.html                 App shell: header (tool bar + Mode/color/undo-
                              redo groups get built as innerHTML from
                              draw-tab.js), sidebar (Draw tab content, also
                              from draw-tab.js), map viewport, plus a
                              generic `#mapContextMenu` div inside the
                              viewport for the right-click menu (see
                              "Wire system" below - not wire-specific
                              itself, just its first consumer)
  app.js                    Sidebar tab switching (Draw/Spawn/Spells/Play -
                              only Draw has real content), Connections
                              settings, sidebar collapse (Tab key toggles
                              it - see below), GREY/GREEN renderer registry
                              (`window.SideTabRenderers`,
                              `window.SideTabHeaderRenderers`)
  map.js                     The battlemap itself: pan/zoom, the canvas
                              draw loop, and ALL mouse-gesture primitives
                              (pan/paint/line/select/**arrange** drag
                              behaviors, plus a right-click `onContextMenu`
                              hook) that draw-tab.js's tools are built
                              from. GREY - never changes based on IT
                              pairing state.
  draw-tab.js                Everything else: walls/textures/structures/
                              doors/**logic pieces**/**wires** data, the
                              five tools (**Select**/Place/Delete/Paint/
                              Configure), the entire color system (now
                              covering wires too), undo/redo. ~5,200
                              lines, no sub-files - same "one big file"
                              philosophy as IT's app.js, just for BT.
  style.css                 Same warm/parchment theme, distinct from IT's
                              dark GM-lamp theme (intentional - different
                              apps, not meant to look identical)
```

### GREY/GREEN convention (load-bearing - keep following it)
Every feature is GREY (works identically whether or not IT is paired) or
GREEN (depends on pairing). **Everything built so far is GREY** - the map,
Draw tab, all four tools, the whole color system, structures, doors.
Spawn/Spells/Play are the planned GREEN tabs (creature data comes from IT
once paired) but have no real content yet. Don't let a GREY feature start
reading pairing state, and don't let pairing state changes affect GREY
rendering.

### The map (`map.js`)
- 32px cells at zoom 1 (`CELL_SIZE`), zoom range 0.5x-2.5x, cursor-centered
  zoom on scroll wheel.
- Canvas is sized to the full window (not the viewport container) and
  redrawn via a single `requestAnimationFrame` scheduler
  (`scheduleDraw`/`drawScheduled`) - this exists specifically to fix a
  white-cursor-corruption bug from resizing the canvas backing store on
  every frame of the sidebar's collapse animation. If a cursor-glitch bug
  ever resurfaces, check this decoupling hasn't regressed before anything
  else.
- **Drag behaviors** (`setDragBehavior`): `'pan'` (default, no tool
  active, and what Configure/Select-Interact use too - click to select/
  act, drag to pan), `'paint'` (continuous apply-while-dragging, used by
  Place-Drag/Delete-Drag/Paint-Drag), `'line'` (Place tool, walls only),
  `'select'` (Delete tool, rectangle), `'arrange'` (Select tool's Arrange
  mode - drag one item from wherever it starts to wherever it ends, see
  `onArrange`/`handleArrangeGesture`). Each tool's Mode buttons in the
  header control which one is active - see `syncDragBehavior()` in
  draw-tab.js.
- **Right-click**: a separate, generic hook (`onContextMenu`, fires
  `cb(info, clientX, clientY)`) from the click/drag system above - not a
  variant of any drag behavior, always available regardless of what
  `dragBehavior` is currently set to. Wire mode's map-side item picker
  (see "Wire system" below) is its first and only consumer so far, but
  the menu itself (`showMapContextMenu`/`hideMapContextMenu` in
  draw-tab.js) knows nothing about wires - it just takes a list of
  `{label, disabled, onClick}` and shows them wherever it's told to. Add
  a new right-click feature by calling `showMapContextMenu` from a new
  `onContextMenu` handler, not by touching the menu's own code.
- **Mouse buttons**: left drives whichever drag behavior is active; the
  middle/wheel button ALWAYS pans regardless of tool (bypasses
  dragBehavior entirely).
- **Arrow-key panning**: smooth accelerate/decelerate physics (not
  instant, not per-keypress jumps) - `PAN_ACCEL`/`PAN_DECEL` chasing a
  target velocity, driven by a held-keys Set so OS key-repeat doesn't
  cause jerky motion. Always available regardless of tool (distinct input
  channel from mouse-drag, no gesture conflict).
- **Wall hitboxes are deliberately narrow** (`resolveWallEdge`,
  `WALL_BAND`/`WALL_VERTEX_MARGIN` = 0.2 each) - a thin band along each
  edge's center, explicitly excluding both the cell's middle and the
  corners/vertices. A click outside all four bands resolves to `edge:
  null`, not a guessed nearest edge - every wall-consuming code path
  (`handleMapClick`, `handleLineGesture`, the hover ghost, Delete's
  hover-highlight, Configure's target) has to null-check `info.edge`
  because of this. `computeCellInfo` always computes BOTH `col`/`row` AND
  `edge` for every hover/click regardless of what's currently selected -
  this is what lets Configure check both a tile and its nearest edge from
  one click without any special-casing on its end.

### Tools (Select / Place / Delete / Paint / Configure - cursor / hammer /
X / paintbrush / wrench icons)
- Live in the **header**, not the sidebar (moved there deliberately - the
  tool switcher is reached for constantly, doesn't belong a scroll away).
  Once a tool is equipped, its button is the only one shown (both the
  deselect control and a status readout); with no tool active, all five
  show. **This "only the active tool's button renders" behavior is a
  common source of confusion when testing/automating clicks** - a
  synthetic `document.querySelector('[data-tool="X"]')` will return null
  if a DIFFERENT tool is currently active, since X's button simply isn't
  in the DOM. Deselect the current tool (click whatever `.header-tool-btn.
  active` is) before trying to reach a different tool's button.
  `TOOL_DEFS` array order = the 1-9 hotkey order (index 0 = "1") and
  drives the button list - both stay in sync automatically because they
  read from the same array. **Select is deliberately first in this array**
  (hotkey 1) - Place/Delete/Paint/Configure shifted up to 2-5 the moment
  it was added, without touching the hotkey handler itself, which just
  reads `TOOL_DEFS[num-1]`.
- **Hotkeys 1-9** equip/toggle tools, only while the Draw tab is the
  active sidebar tab (`window.isSideTabActive('draw')`, exposed
  explicitly from app.js rather than relying on cross-script `let`
  scoping). Both this and the Tab hotkey below guard against OS key-repeat
  via `e.repeat` - without it, holding the key rapid-fires the toggle.
- **Q** cycles whichever tool's own two-mode toggle is active (Select's
  Arrange/Interact, Place's Click/Line-or-Drag, Delete's Click/Selection,
  Paint's Click/Drag, Configure's Edit/Wire) via `cycleActiveToolMode()`.
  This handler has an explicit per-tool whitelist gating which tools it
  even applies to - when Select was added, its own mode-cycling logic was
  written into `cycleActiveToolMode()` correctly, but `'select'` was
  never added to this separate whitelist, so Q silently did nothing while
  Select was equipped. Found and fixed once already; if a future tool
  gets its own Q-cyclable mode pair, check this whitelist specifically,
  not just `cycleActiveToolMode()` itself - they're two separate places
  that both have to know about a tool.
- **Tab** collapses/expands the sidebar (in app.js, not draw-tab.js) -
  this used to put the active tool down, but that's redundant now that
  1-9 can toggle a tool off directly, so Tab was freed up for this
  instead. `e.preventDefault()` has to run on EVERY firing of the
  handler, repeats included, not just the first (non-repeat) one - it
  used to be skipped whenever `e.repeat` was true because the early
  `if (e.repeat) return` ran before the `preventDefault()` line, which
  let the browser's native focus-cycling take over the moment Tab was
  actually held down instead of just tapped. Fixed by moving
  `preventDefault()` before the repeat check; the repeat check itself
  still correctly limits the actual sidebar toggle to once per press.
- **Place** modes: Click (single application per click, drag pans instead)
  and either **Line** (walls selected - see below) or **Drag** (anything
  else selected, continuous paint-while-dragging). The second mode's
  label/behavior switches automatically based on what's selected; picking
  a new item doesn't reset which of Click/non-Click slot you were in, only
  adapts what the non-Click slot means. Defaults to solid wall the first
  time it's equipped with nothing already selected.
- **Delete** modes: Drag (default, continuous - note this means even a
  plain click-with-zero-movement fires a zero-size *selection rectangle*
  via `handleSelectGesture`, not a simple point-delete; the net effect at
  that exact cell/edge is the same, but if you're tracing delete behavior
  in code, both `handleMapClick`'s delete branch AND `handleSelectGesture`
  are worth checking) and Selection (drag a rectangle, everything inside
  it deletes on release - walls take priority over the cell they border
  in both modes, same convention as Paint's targeting). Deleting anything
  now also clears its color override (see the color system section) and,
  for structures, its rotation.
- **Paint** modes: Click and Drag (mirrors Place). Also has its own Mode
  switch in the header now, to the left of the color boxes.
- **Configure**: two modes, **Edit** (the original behavior below) and
  **Wire** (connects Logic pieces/structures/textures/walls to each
  other - see "Wire system" below for the whole thing, it's substantial
  enough to warrant its own section). Edit mode selects everything at a
  clicked spot for viewing/editing - doesn't place or delete anything
  itself. **One click, one selection
  mode** (an earlier two-mode Tile/Grid version was tried and explicitly
  dropped in favor of this) - `configureTarget = {col, row, edge}` always
  carries both the cell and whatever edge that same click resolved to
  (edge is `null` if the click wasn't close enough to any edge), so a
  single click can surface a tile's contents (texture, cell-based
  structure) and its nearest edge's contents (wall, door) simultaneously.
  Gathered in `renderConfigurePanel` in the fixed Wall → Texture →
  Structure → Logic → Creature order (the last two are listed in the
  code's comments, not implemented - nothing to check yet), skipping any
  category with nothing in it rather than showing an empty placeholder
  for it; only "nothing at all" gets its own "Nothing here." message. Each
  item renders as: a bordered preview box (visually matching the Place
  menu's own swatches, not reused via the same CSS class since that one
  assumes a grid context this isn't in), then Type/Name text in the app's
  label-row font convention (`.settings-row-label`), then a Positioning
  section (X/Y/Z - col/row directly, Z always 0, map origin at col=0/
  row=0 - and a Rotation readout in degrees with a rotate button using
  `RESET_ICON` purely for its circular-arrow shape, only shown for
  structures/doors since walls/textures have no rotation concept to act
  on), then a Colors section (Primary/Secondary as a circle+hex chip
  styled as one pill with two independently-clickable halves - circle
  opens a mini SV-square-plus-sliders picker, hex text becomes an
  editable input - plus a reset button, disabled until that specific
  color's been manually overridden). Selecting a NEW target (or leaving
  Configure entirely - see below) closes any open picker/hex-input.
  Configure's own selection is shown on the map as a blue highlight (tile
  fill + edge line, both at once when relevant) - deliberately blue, not
  Delete's red, so the two don't read as "about to be removed". The
  highlight is suppressed entirely while a color picker is open (an item
  being actively recolored shouldn't also sit under a tint that distorts
  how the new color reads), and clears immediately (not on the next
  incidental redraw) the moment the tool is put down - both wired through
  explicit `window.BattleMap.requestRedraw()` calls at the state-change
  points, not left to happen implicitly. No editing beyond rotation and
  color exists yet - deletion/movement/duplication of a Configure
  selection are unbuilt.
- **Modes never reset on switching tools or via Tab** - each tool has its
  own independent mode variable (`placeMode`/`deleteMode`/`paintMode`)
  that only ever changes via explicit DM action. `selected` (what's
  currently chosen to place) also persists the same way, ACROSS most
  things - but see the swatch-click gotcha below, since it's easy to
  misread this persistence when testing.
- **Clicking an already-selected swatch deselects it** (`selected = null`)
  - a deliberate toggle-off, the same idea as clicking an already-active
  tool's own button. This is a real trap when writing test scripts: a
  swatch's `.active` CSS class requires BOTH `selected` matching AND
  `activeTool === 'place'` (see `isActive` in `renderWallSwatchRow` and
  its siblings) - so once a different tool is active, checking `.active`
  in the DOM does NOT tell you whether that swatch is still the thing
  `selected` actually points to. A test that uses ".active" as a proxy
  for "already selected, don't re-click it" will get this wrong and
  accidentally re-click an already-selected swatch, silently nulling
  `selected` via the toggle-off path - which then falls through to
  Place's `!selected` default (plain wall/solid) on the next tool
  equip. This produced a long, confusing false-alarm chase this session
  (a "recolored item's color leaking onto whatever's placed next" report
  that turned out to be entirely this test-harness mistake, not a real
  bug - the actual color-clearing-on-place/delete fix was correct all
  along). If you need to know "is X currently selected" from outside the
  app, don't infer it from `.active` classes across a tool switch -
  either avoid re-clicking a swatch you have reason to think is already
  selected, or select something else first as a clean reset before
  re-selecting your actual target.
- **Undo/redo**: snapshot-based (`snapshotState()`/`restoreState()`,
  whole-Maps deep copy including `walls`/`textures`/`structures`/
  `structureRotations`/`doors`/`wallColors`/`textureColors`/
  `structureColors`), not per-field diffs - simple, and cheap enough at
  this data size. A whole gesture (one paint drag, one line drag, one
  selection-delete, one Configure recolor session) is a single undo step
  via `info.isGestureStart` on the click info map.js passes (or an
  explicit `pushUndoSnapshot()` at the start of a picker-editing session
  for Configure, not per slider tick). Ctrl+Z/Ctrl+Y work regardless of
  which tool is active.

### Structures
Five types now: **stairs**, **chest**, **item** (a tied sack), **lever**,
**door**. All selected from the Structures section of the sidebar swatch
picker, all sharing the same rotation mechanic (`structureRotation` - the
rotation baked into the NEXT one placed, cycled 0-3 by the **R** hotkey
while Place is armed with a structure selected; resets to 0 whenever the
selection changes, even within Structures, so rotation is a dial for
"whatever's currently chosen" rather than a persistent global - see
`setSelected`). Already-placed structures can also be re-rotated directly
through the Configure tool (see above), which is the only way to change
one's rotation without deleting and re-placing it.

- **Stairs**: the one type with genuinely bespoke rotation behavior - see
  `drawStairsIcon`. 6 lines increasing in length linearly (the last one
  spans the icon's full height edge to edge), plus a solid, backed
  up/down arrow. The lines rotate a full 90° per step; the arrow only
  ever points straight up or down and never spins itself - it flips once,
  at rotation 2, and stays there through rotation 3. If you need to
  re-derive this: rotation 0/1 = arrow up, rotation 2/3 = arrow down,
  independent of which way the lines have turned.
- **Chest, item (sack), lever**: all built from the person's own SVG
  files (`Chest.svg`, `Sack.svg`, `LeverNiceVector.svg`), not
  hand-drawn placeholders - see "Custom SVG art" below for how those get
  into the app. All three use simple whole-icon rotation (no
  special-casing like stairs). **Lever has a real on/off state**
  (`leverOnStates`, cell-keyed, missing/false means off) - toggled the
  same way the door's open/closed state is, via Select tool Interact
  mode. Drawn mirrored (`ctx.scale(-1,1)` about its real pivot point,
  not an angle negation) rather than redrawn from scratch for the "on"
  position.
- **Door**: technically a structure (selected from Structures, shares
  `structureRotation`/the reset-on-switch behavior/the R hotkey) but
  NOT stored in the `structures`/`structureRotations` maps - it sits on
  an **edge**, exactly like a wall, so it lives in its own edge-keyed
  `doors` Map (`col,row` edge key → rotation value directly, since
  there's only one door "type" so presence and rotation collapse into
  one map). Placing a door on an edge deletes whatever wall was there
  first (and vice versa isn't possible - walls can't be placed onto an
  edge that already has a door without first deleting it, same
  edge-takes-priority convention Delete already uses). Drawn as a normal
  wall line plus a thicker, backed leaf rectangle inset ~10% from each
  end (`drawDoorIcon`, orientation-generic via direction/perpendicular
  vectors rather than assuming horizontal - works identically for
  vertical doors). Rotation encodes hinge-corner × swing-side (4 distinct
  combinations), but the swing-direction arc is **only drawn during
  placement** (the Place-tool ghost preview, `isGhost=true`) - a
  committed, already-placed door shows no arc at all. This was an
  explicit, deliberate simplification requested this session; if it ever
  needs to persist on the map too, that's a one-line change (drop the
  `isGhost` gate) but wasn't wanted as of this writing. **Now has a real
  open/closed state** (`doorOpenStates`, edge-keyed, missing/false means
  closed) - toggled by the Select tool's Interact mode (a left-click on
  the door) or, mid-wire-build, no runtime effect from wiring itself yet
  (Play mode's job). Open draws the leaf swung out from its hinge instead
  of flush in the frame; the frame line itself is hidden while open.
- **Backing convention, extended to structures**: only shapes with a real
  interior (the stairs arrow, the chest body + latch, the lever's
  bracket/circle/base-plate/arm, the sack body/folds/tie-band, the door's
  leaf) get an opaque backing fill masking whatever's beneath (texture,
  grid); thin line-only elements (the stairs' 6 lines, the lever's arm-
  outline stroke) never do, so a texture directly underneath stays
  visible around/between them. This was a real, reported, and fixed bug
  early on (an earlier version gave the WHOLE CELL a background fill,
  which bled into the north/west grid borders and hid neighboring
  textures that had no business being hidden) - don't reintroduce a
  whole-cell fill for any structure.

### Textures now rotate too
`textureRotations` Map, cell-keyed, same convention as
`structureRotations`. `placeRotation` (renamed from the old
`structureRotation` - it's shared by both categories now) is the one
dial the R hotkey turns while Place is armed, regardless of whether a
structure or a texture is currently selected. Patterns like diagonal/
dotted/wavy actually look different rotated; solid/cracked are rotation-
invariant but harmlessly carry a rotation value anyway rather than
special-casing which patterns "care" - simpler to always store and
apply it than to ask each pattern whether it matters. `drawTexture()`
takes rotation as its 4th argument now (before `view`).

### Paint reaches through structures to the texture underneath
`STRUCTURE_HIT_RADIUS_FRACTION = 0.35` (of one cell, from center) -
Paint's click resolution checks this radius before assuming a click on
a structure's cell means the structure itself; outside that radius but
still in the same cell, the click reaches the texture instead. Priority
overall: logic-on-edge > door > wall > structure (within its radius) >
texture. See `isNearCellCenter` - this radius is reused (and extended
with `LOGIC_HIT_RADIUS_FRACTION = 0.18`, smaller again) by the Select
tool's Arrange mode - see below.

### Logic pieces
**Five types as of the September 2026 session**: **Switch** and
**Break** (renamed from "Breakable" that session - label-only rename,
`type.id`/`typeId` literal changed from `'breakable'` to `'break'`
throughout, no behavior change, no backward-compat shim since nothing
persists a save file across the id change yet) plus three brand new
ones added the same session - **Hide** (eye-with-slash icon), **Recolor**
(paintbrush icon), **Move** (four-way cardinal-arrow icon). All five are
placed from the same Logic section in the sidebar swatch picker. **All
five are cosmetic-only, explicitly** - same status as the original two:
an icon placeable on the map, visible/selectable in Configure (position
only, no rotation, no color system), but with zero actual runtime
behavior wired up. The icons were chosen to describe what each will
eventually DO once Play mode exists (hide/show a target, recolor a
target, move a target - presumably via the Wire graph), not what they do
today. Don't build real behavior for any of these without being asked -
they were explicitly confirmed as cosmetic-only when added.

Keyed in one shared `logic` Map (`key -> typeId`) that can hold EITHER
an edge key (`wallKey()`, placed on a line) or a cell key (`cellKey()`,
placed on a tile) - both shapes coexist in the one Map since they're
textually distinguishable (an edge key always contains `:` - see
`parseWallKey`); every logic-consuming code path checks for that rather
than needing two separate Maps the way walls/textures do. Rendered as a
half-size icon (`LOGIC_ICON_SCALE = 0.5` of the reference cell/edge
size) sitting on an opaque backed square (`LOGIC_SQUARE_PADDING = 1.2`×
the icon) that covers whatever's underneath - always drawn LAST in
`renderOverlay`, on top of everything else at that spot, so it's never
accidentally hidden by a wall/texture/structure sharing its key.
Deleting/pasting/moving one also carries `switchTriggers` (see below)
and, now, its wire connections - see "Wire system".

**Icon-scale gotcha, learned adding these three**: a filled sub-shape
(the Recolor paintbrush's bristle wedge, its paint-dab circle) needs to
occupy noticeably MORE of the 24×24 design grid than looks necessary on
paper, or it disappears entirely once scaled down to the actual
on-map/swatch icon size (~9-24px). A first attempt at the paintbrush
(a thin wedge + a 1.8px-radius dot) rendered as an indistinguishable
plain diagonal line in both the swatch tray and on the map - confirmed
by screenshotting and zooming in, not by assumption. Fixed by roughly
doubling the wedge's spread and the dot's radius. If you add a sixth
Logic icon (or touch these three), verify at actual render size via a
zoomed screenshot before considering it done - don't trust how a path's
coordinates "look" in the source.

**The Configure header's gear/Settings button (`GEAR_ICON`) was
misdrawn as a sun/brightness icon**, not a cog - it was a circle with 8
thin radial spokes, no teeth, which reads as "brightness" to anyone
looking at it despite being named `GEAR_ICON` and used for Settings.
Fixed by swapping in a real cog glyph (a ring of trapezoidal teeth
around a center hole - the standard Feather-icons "settings" path).
This wasn't a Logic-specific bug, just found and fixed in the same
session as the Logic additions - if a future icon looks visually wrong
despite matching its own name/comment in code, don't assume the
description is right; screenshot it.

A Switch has its own "Triggers on:" dropdown in Configure's Edit mode -
`switchTriggers` Map, same key as the switch itself, value is just a
plain category string (`'wall' | 'texture' | 'structure'`) identifying
which of the co-located items at that exact spot it's wired to. This
predates the real Wire system below and is NOT the same mechanism - a
switch's trigger is a same-location-only, category-only pointer with no
actual runtime effect yet (the UI to set it exists, nothing reads it).
Don't confuse this dropdown with the Wire tool's own "Triggers on:"-
shaped dropdowns elsewhere in Configure - they look similar
(`.header-dropdown`-based) but are unrelated systems with unrelated data.

### Select tool (5th tool, hotkey 1 - see "Tools" above for why it's
first and what that did to the other hotkeys)
Two modes, **Arrange** and **Interact**, for testing/prepping/utility
outside of Play mode (which doesn't exist yet) - explicitly NOT the same
thing as Play mode's eventual click-to-trigger-a-live-encounter behavior,
though Interact's lever/door toggle looks similar on the surface.

- **Arrange**: click-and-drag any item to a new location. Driven by a
  new `'arrange'` drag behavior in map.js (`onArrange`, mirrors `onLine`/
  `onSelect`'s start/update/commit phases exactly). `findGrabbableAt`
  resolves what's actually grabbable at the press point using the SAME
  edge-first, then within-radius-of-cell-center priority Paint/Delete
  already use for their own targeting (logic-on-edge > door > wall, then
  among a cell's own three layers: logic within `LOGIC_HIT_RADIUS_FRACTION`
  (0.18), structure within `STRUCTURE_HIT_RADIUS_FRACTION` (0.35), texture
  with no radius at all since it's the whole cell and therefore the
  outermost/largest by construction). This is what makes "grab any of a
  stacked cell's three layers independently" actually work - confirmed by
  direct testing (drag from dead center grabs logic, drag from just
  outside logic's radius but inside structure's grabs the structure,
  leaving the texture untouched either way). `moveItem` carries over
  every per-instance thing that travels with the item (color, rotation,
  on/off state, a switch's trigger) rather than resetting to defaults -
  this is the same object relocating, not delete-then-place - and
  finishes by repointing any wires that touched its old key to the new
  one (`updateWireReferences`). **A real bug found and fixed here**:
  `moveItem` originally cleared the item's OWN old-key data but never the
  DESTINATION's pre-existing per-instance data before conditionally
  applying the incoming item's own (possibly absent) values - so an item
  moved onto an already-occupied cell/edge could silently inherit
  whatever rotation/color/state the PREVIOUS occupant there had, for any
  property the incoming item didn't itself override. Fixed by explicitly
  clearing the destination's own rotation/color/state Maps first, in
  every branch (wall/door/structure/texture/logic), before the
  conditional sets - and by calling `removeWiresReferencing` on the
  destination's old occupant too, since overwriting it should destroy its
  wires the same way deleting it normally would. A dropped item shows a
  ghost-preview highlight while dragging (dim green at the origin,
  brighter green at the current valid drop target, skipped entirely when
  the cursor isn't over a valid destination for that item's category -
  e.g. an edge-bound thing hovering dead center of a cell).
- **Interact**: left-clicking a structure activates it - currently just
  toggles its own on/off state if it has one (lever via `leverOnStates`,
  door via `doorOpenStates`), no-op for chest/stairs/item since "what
  structures do" beyond that is explicitly future work. This is NOT
  routed through the Wire graph at all yet - it only touches the
  literal thing clicked, nothing it's wired to. That cascade is Play
  mode's job, still unbuilt.
- Switching Select's own mode (via the header buttons or Q) cancels any
  arrange-drag in progress, same convention Configure's Edit/Wire switch
  already established for cancelling a pending wire. Leaving the Select
  tool entirely does the same, defensively, in case a drag somehow
  outlives the tool switch (map.js's own gesture, once started by a
  mousedown, keeps running independent of whether `activeTool` changes
  mid-drag - clearing `arrangeDragItem` means the eventual commit just
  quietly no-ops instead of moving something after the fact).

### Wire system (Configure's Wire mode)
The single largest addition since 0.3.0. Connects two placed items
together - a Logic piece to a structure, a switch to a door, anything to
anything really, since nothing enforces semantic sense at the data level
yet (that's Play mode's job, still unbuilt - see "What's explicitly NOT
built yet"). Read this whole section before touching any of it; the
pieces are spread across three different UI surfaces that all have to
stay in sync with one shared piece of state.

**Data model**: `wires` array, `[{ fromKey, fromCategory, toKey,
toCategory, color }]`. Fan-out is unrestricted - one item can be the
`from` of many wires, the only real constraint is on the exact
`(from, to)` pair (duplicate destinations are dimmed, not blocked
outright, in every picker that lists them). `color` defaults to
`DEFAULT_PRIMARY_COLOR` (`#14100d`) at creation - see "Wire color"
below. Snapshotted/restored whole (shallow-copied) alongside every other
Map for undo/redo, same convention as everything else.

**Three ways to build a wire - deliberately built as three independent
front-ends over the same underlying state**, not three separate
features: `pendingWireSource` (`{key, category}` or null - the wire
currently being built) and `pendingWireDestTarget` (the location, once
one's been clicked) are shared globals every surface reads and writes.
1. **Sidebar** (`renderWirePanel`/`renderWireItemRow`): each item at the
   current `configureTarget` gets its own "+" to start a wire from it,
   and a live "Connected to: [Choose...]" row (dimmed until a
   destination location's been clicked) while one's pending. Cancel via
   an "x" that's present from the moment the wire's conception (clicking
   "+"), not just once a destination exists.
2. **Header** (`renderHeaderWirePickers`): a `[Source] -> [Destination]`
   picker pair, both boxes dimmed until there's something to pick. This
   exists specifically so the DM can change the SOURCE while a wire's
   still being built without needing the sidebar open - the sidebar's
   own "+" is one-shot per item (clicking a different item's "+" restarts
   the pending wire from scratch), but the header's source box stays
   live/reopenable throughout, letting you repoint an in-progress wire's
   source without starting over.
3. **Map right-click** (`showWireContextMenu`, built on the generic
   `showMapContextMenu` - see map.js's notes above): right-click opens a
   floating menu listing whatever's at that location; picking an entry
   either arms the pending source (nothing pending yet) or commits the
   wire (one already pending). Left-click in Wire mode does NOT open
   this menu - it does the same plain select-and-highlight bookkeeping
   Edit mode's own left-click always did (updates `configureTarget`/
   `pendingWireDestTarget`, moves the map highlight), nothing more. This
   was a deliberate late correction - the menu used to also open on
   every left-click, which combined with the sidebar+header both always
   being visible amounted to three redundant, simultaneously-active
   pickers; now only right-click summons the menu; left-click is quiet.
   The menu itself is generic and reusable (see map.js notes) - Wire
   mode is its first consumer, not something baked into it.

**A real click-through bug, now fixed**: picking an item from the map's
context menu was ALSO registering as a plain click on whatever sat
underneath it (a wall, most visibly), because a menu click still starts
with a `mousedown`, which bubbles to the map viewport's own mousedown
handler regardless of `stopPropagation()` on the later `click` event -
they're separate events entirely. Fixed with a `mousedown` listener
directly on the menu container that stops propagation unconditionally.
If a future floating UI element sits inside `#mapViewport`, check for
this same leak before assuming `stopPropagation()` on click alone is
enough.

**Editing an existing wire**: every committed wire's listing (in the
sidebar, under whichever item's section is currently showing it) reads
`"[Source] -> [Input]"`, with BOTH sides as independent, reopenable
dropdowns - not static text on either end. Reopening either one lists
items at THAT endpoint's own location (`targetFromKey` reverses a key
back into a `{col,row}`/`{edge}` shape), so repointing either side never
requires deleting and recreating the wire. Changing the SOURCE needs no
special "move" logic - each item's section is built by filtering `wires`
fresh on every render, so a wire whose source changes just stops
matching its old section and starts matching the new one on the next
render; "the section it appears under moves" falls out of that for
free, don't go looking for code that explicitly relocates a listing.

**A wire shows in BOTH endpoints' sections, always in the same fixed
order.** This was a real gap fixed late in the session: originally a
wire only appeared in its SOURCE item's own listing - the receiving end
showed nothing about incoming wires at all. `renderWireItemRow` now
computes a `relevantWires` set (wire touches this item as EITHER
`fromKey` OR `toKey`) for what actually renders, while keeping a
narrower `fromWires`-only set for the one place that still needs it
specifically (the pending row's own duplicate-destination check, which
only cares about wires already going FROM the exact item being wired
from). The row always renders `"[Source] -> [Input]"` in that fixed
order regardless of which role `item` plays for that particular
render - never flips to "[Input] -> [Source]" just because the
receiving end happens to be showing it. Order across multiple wires in
one section follows `wires` itself (new wires are always pushed to the
end), i.e. "the order it was wired in" - don't re-sort by role or
anything else.

**Dropdown option labels vs. closed-button labels are deliberately
different formats**, and this flipped once mid-session - worth getting
right if touched again. A dropdown's OPTIONS (the list you see when it's
open) show the full `"Category: Item"` form (`wireEndpointFullLabel`,
e.g. "Structure: Lever") - this was tried as category-only at one point
("Structure" alone, on the reasoning that at most one item per category
can occupy a given location so the category alone disambiguates) and
explicitly reverted back to the fuller form. The CLOSED button (before
you open it) shows only the specific item name (`wireEndpointLabel`,
e.g. "Lever") - no category prefix. Keep these two functions and their
uses separate; conflating them was the actual mid-session regression.

**Wire endpoints don't all anchor at the cell's dead center** -
`itemScreenCenter(key, category, view)` takes category into account for
cell-keyed endpoints specifically: texture anchors in the upper third of
the cell, structure in the lower third, logic (and anything with no
specific rule) stays centered. This is what stops two wires into the
same cell - one to its texture, one to its structure - from drawing
exactly on top of each other and reading as one line. Edge-keyed
endpoints (walls, doors) always anchor at the plain edge midpoint
regardless of category - "doesn't apply to doors" falls out of that for
free, since a door is edge-keyed and never reaches the cell-specific
offset logic at all.

**Wire color**: each wire carries its own `color`, editable via a
picker that appears after each wire's own listing in the sidebar and
after the header's `[Source] -> [Destination]` pair (before undo/redo)
in the header - `wireDrawColor` is the header's own instance, the color
a NEW wire will actually get, which also colors the live in-progress
line following the cursor while one's being built. **This went through
two different implementations worth knowing about if it comes up
again**: it was first built with a native `<input type="color">` (a
deliberate simplification to avoid re-duplicating the SV-square picker's
drag-handling machinery a third/fourth time) - then explicitly reverted,
on request, back to the SAME custom SV-square-plus-sliders picker
Configure's own Edit-mode colors and the header's Paint tool use
(`renderWireColorPicker`, own fixed element ids `wireSvSquare`/
`wireHueSlider`/etc. so its drag wiring stays independent of the other
two instances - this is now the FOURTH instance of the one-time
window-level mousemove/mouseup drag-listener pattern, see that section
below). **A real positioning bug happened in between**: an earlier
compact sidebar variant (`renderWireColorCompact`, swatch+reset in one
small pill, no hex) put the picker's dropdown inside `.configure-color-
chip`, which has no `position: relative` of its own - only
`.configure-color-row` (the wrapper `renderWireColorRow` uses) has that,
so the dropdown was positioning itself relative to some distant
ancestor instead, rendering somewhere invisible/off-screen rather than
visibly broken. Fixed by dropping the compact variant entirely and using
`renderWireColorRow` (hex included) inline in the wire's own row instead
of on a separate line below it - simplest fix, and reintroduced the hex
code the compact variant had dropped, which was wanted back anyway. If
a new compact color control is ever built, give its wrapper `position:
relative` explicitly rather than assuming the picker will "just work"
wherever it's dropped.


### Custom SVG art (chest, sack, lever)
The person designs these himself (Inkscape/Figma) and hands over raw
`.svg` files using the app's own exact hex colors already
(`#14100d` ink, `#f4ede2` backing) - no separate "import" pipeline exists,
each one gets manually ported into two places:
- **Sidebar swatch preview** (`structureSwatchSvg`): the SVG markup is
  embedded close to verbatim (own `viewBox`, own path data/rects) minus
  any design-tool artifact (background rects at the file's own canvas
  size, etc.) - explicit `stroke-width` has to be added by hand, since
  these source files tend to omit it (default browser stroke-width of 1
  reads as basically invisible once scaled down into a small button) -
  the working ratio used throughout is **stroke-width ≈ 0.035 × the
  file's own native canvas size** (this matches what the hand-built icons
  like stairs/door already use, just expressed against a much larger
  native coordinate system than their 50-unit one, so the numbers look
  different but the visual weight matches). A rect exported with
  `transform="rotate(90 ...)"` around its own corner can usually be
  simplified to a plain, larger axis-aligned rect instead of replaying
  the rotation (rotating a rect 90° around its own corner just swaps
  width/height and repositions it - see the chest's body rect for the
  worked example) - do this rather than reproducing the transform
  verbatim, it's simpler and identical in output.
- **Map canvas rendering** (`drawChestIcon`/`drawItemIcon`/
  `drawLeverIcon`): reconstructed with real canvas primitives, using
  `new Path2D(<the exact "d" attribute from the source file>)` for any
  curved/complex path so the actual point data never has to be
  hand-transcribed - only rects/circles need manual translation (trivial,
  `ctx.fillRect`/`ctx.arc`). Scale to fit the cell via `size /
  Math.max(nativeWidth, nativeHeight)` (fit-by-larger-dimension, centering
  the shorter axis) since none of these source canvases are square the
  way the cell itself is - don't assume 1:1 aspect. All three now accept
  a `colors = {primary, secondary}` param (falling back to the standard
  ink/backing constants) so they participate in the same per-instance
  override system as everything else - see the color system below. One
  real bug from this: the lever's arm was hardcoded to a fixed grey
  (`#D9D9D9`) as a straight port of the source file's own literal color,
  when it should have followed the secondary/backing override like every
  other filled shape in the icon - fixed to use `secondaryColor` instead.
  If a future custom-art structure has an oddly-specific hardcoded color
  that doesn't look like it belongs to the ink/backing pair, check
  whether it should actually be tracking one of them.
- **Sizing/weight are iteration, not one-shot** - both the chest and sack
  needed a further ~5-10% size reduction and a stroke-weight bump after
  first landing (their native coordinate systems are much larger than the
  hand-built icons', so a stroke-width or scale factor that looks
  reasonable on paper can still read wrong once actually on the map -
  don't treat the first pass as final without a screenshot at real
  placement size).
- **Swatch button aspect ratio is fixed at ~5:3** (established for the
  wall/texture icons, all using a 50×30 viewBox) - a custom SVG with a
  very different native aspect (the lever's is roughly square, 148×143)
  will letterbox in the button rather than fill it. This is expected, not
  a bug to silently "fix" by stretching - if it needs tightening, either
  ask for a second export at the right proportion or crop the existing
  one via a narrower `viewBox` (done for the sack's swatch specifically -
  kept its full native art for the map, but cropped to 140×84 - exactly
  5:3 - for just the button preview, keeping the tied neck and upper body
  and letting the crop cut off the lower portion of the sack rather than
  distorting the whole shape).

### The color system (Paint tool + Configure)
This is the most complex part of the app now - read carefully before
touching it.

- **Two colors, primary and secondary.** For walls, only primary applies
  (the stroke) - no secondary concept exists for them. For textures,
  primary is the pattern's own ink, secondary is a fill painted behind it
  (the cell's "floor" color) - only rendered when an instance actually has
  a secondary override, so the default (no paint applied) still renders as
  transparent background. For structures, primary is the ink outline,
  secondary is the backing fill (see the backing convention above) -
  both apply to every structure type including doors.
- **Per-instance overrides**: `wallColors`/`textureColors`/
  `structureColors` Maps, keyed the same way as `walls`/`textures`/
  `structures` (an edge key via `wallKey()` for walls and for door
  structures specifically, a cell key for everything else). Something
  with no entry in these Maps just uses its type's default color, same as
  always.
- **A new item always starts at default colors, even if something
  differently-colored used to occupy that exact spot.** This required
  explicitly clearing the relevant color-override Map entry at BOTH
  every placement call site (single-click wall/texture/structure/door,
  both line-mode wall paths) AND every deletion call site (single-click
  and rectangle-select, across all four categories) - not just one or the
  other. This was a real, reported bug (recoloring something via
  Configure, deleting it, then placing something new at the same spot
  would inherit the old color) - if you add a new placement or deletion
  code path for any category, make sure it clears that key's entry in the
  matching color Map too, on both ends.
- **State is persistent floating-point HSV, not re-derived hex** -
  `paintPrimaryHSV`/`paintSecondaryHSV` `{h,s,v}` objects are the actual
  source of truth for the PAINT TOOL's currently-loaded color; the
  Configure panel's per-item colors are separate and don't share this
  state - each color chip's picker derives its OWN hsv fresh from that
  item's current hex via `hexToHsv` when opened (there's no persistent
  floating-point HSV tracked per placed item, only per the Paint tool's
  "next stroke" color). `paintPrimaryColor`/`paintSecondaryColor` (hex)
  are derived FROM the Paint tool's HSV, never the other way around, for
  any in-app edit (the SV square, the H/S/B sliders). **This is a fix for
  two real, reported bugs** (hue collapsing to 0 whenever saturation or
  brightness hit zero; the SV marker visibly drifting when only the hue
  slider moved) - both were caused by re-deriving h/s/v from the stored
  8-bit hex on every render, which is lossy exactly at the achromatic
  extremes and doesn't always round-trip exactly. Only genuinely external
  sources (a recent/favorite chip, the system eyedropper, or Configure's
  own per-item picker opening fresh) derive HSV from hex, and only once,
  at that entry boundary. **Don't reintroduce a `hexToHsv(currentColorHex)`
  call anywhere in a render/live-update path for the PAINT TOOL's own
  state** - always read `paintPrimaryHSV`/`paintSecondaryHSV` directly
  instead. Configure's picker is the one legitimate exception to this
  rule, by design, since it has no persistent HSV of its own to read.
- **Four separate mini SV-square-plus-sliders pickers now exist**, all
  visually identical (same `.sv-square`/`.sv-square-mini`/
  `.paint-sliders`/`.paint-sliders-mini` CSS) but independently wired:
  the sidebar Paint Mode panel's full-size one, the header's compact one,
  Configure's own (`renderConfigureColorPicker`/`wireConfigurePanel`),
  and the wire color picker (`renderWireColorPicker`/`wireWireColorRows`
  - shared between its sidebar and header appearances via the same
  functions, unlike the other three which are each their own standalone
  thing). Each new one was built as a deliberate NEW, parallel
  implementation rather than a refactor of an existing one - the header
  picker is tightly coupled to the two global `paintPrimaryColor`/
  `paintSecondaryColor` values via many small event handlers, and
  generalizing any of these to point at an arbitrary target was judged
  riskier each time than duplicating the (fairly small) SV-square/slider
  wiring again with its own drag-active flag and one-time window-level
  mousemove/mouseup listeners (see "the drag-listener pattern" below -
  this is now the FOURTH instance of it). **The wire picker's own history
  is worth knowing**: it was first built with a native `<input
  type="color">` instead of this SV-square approach (a deliberate
  simplification), then explicitly reverted back to match the other
  three on request - "use our custom color picker for everything going
  forward." If a fifth picker context is ever needed, keep duplicating
  rather than trying to retrofit a shared abstraction on top of four
  already-diverged implementations - that's been asked for and explicitly
  affirmed as the right call twice now.
- **All three pickers had the same bug at different times**: the slider
  track gradients (Hue's rainbow strip, Saturation's and Brightness's
  color-dependent strips) were only ever set reactively, during drag/
  slider-input - meaning they rendered blank/default until the user
  first touched one. Fixed by also computing and setting the
  `--track-gradient` CSS custom property inline at RENDER time, not just
  reactively (see `updateHeaderSliderGradients`,
  `updateSliderGradients`/the sidebar's initial-gradient call at wiring
  time, and `renderConfigureColorPicker`'s inline `style=` attributes for
  the third). If a new picker is ever added, set this at render time from
  the start rather than rediscovering this bug a fourth time.
- **Configure's color chip**: circle + hex code rendered as one visual
  pill (`configure-color-chip`) with two independently-clickable
  sub-elements inside it - clicking the circle opens the picker, clicking
  the hex text turns it into an editable `<input>` (Enter or blur
  commits, validated against `/^#[0-9a-fA-F]{6}$/`; Escape cancels). A
  reset button next to the chip clears that specific override, disabled
  whenever there isn't one to clear. Two bugs worth knowing about if
  touching this again: (1) when two DIFFERENT categories happen to share
  the same underlying key (a texture and a structure on the same tile
  both use that tile's cell key) their picker-open/hex-editing state has
  to be compared on `category` as well as `key` and `which` - comparing
  only key+which will make opening one item's picker also open the
  other's identically-positioned row; (2) the reset button's
  enabled/disabled state is only set at full-render time, not by the
  picker's live in-drag DOM patching (`updateConfigurePickerLive`) - a
  drag/slider-input that establishes the FIRST override on a
  previously-default color needs an explicit `renderDrawTab()` on
  mouseup (not just the live patch) or the reset button stays stuck
  showing disabled despite a real override now existing.
- **Auto-shade linkage** (Paint tool only, not Configure): picking one
  color while the other is still at its default automatically derives the
  other as an adjacent shade - same hue, same brightness, saturation
  offset by `SHADE_SATURATION_OFFSET` (25 points; primary always more
  saturated than secondary). Tracked via `primaryManuallySet`/
  `secondaryManuallySet` flags, which also drive each color's reset
  button (a small corner-badge icon on its preview swatch, disabled/
  greyed until that specific color has been manually touched). Reset
  means "go back to following the other color" if that one's been
  manually set, or the hardcoded base default if neither has.
- **Recents & Favorites** (Paint tool only): `recentPaintColors` (max 15,
  5 cols x 3 rows in the sidebar / 6 most recent, 2 cols x 3 rows in the
  header - both most-recent-first, committed on gesture END not every
  drag step via `commitPaintColorToRecents`) and `favoritePaintColors`
  (right-click a recent to add; right-click a favorite again to remove,
  with a confirmation popup, not immediate deletion - the header's own
  Favorites dropdown deliberately can't remove at all, only the sidebar
  can, via `wireColorChipGrid`'s `allowFavoriteRemove` flag). Both
  persist across app restarts via `localStorage` (`bt-paint-recent-
  colors`/`bt-paint-favorite-colors` keys, same convention as IT's own
  localStorage usage).
- **Shared chip/confirm-popup logic**: `renderColorChipGrid`/
  `wireColorChipGrid` are container-parametrized (take a DOM container,
  a CSS grid class, and now the `allowFavoriteRemove` flag) specifically
  so the sidebar's 5-column grid and the header's 2-column mini-palettes
  reuse the exact same click/right-click/confirm-removal behavior instead
  of two copies drifting apart.

### The drag-listener pattern (now four instances)
Any drag-based UI (the header's SV square, the sidebar's SV square,
Configure's own SV square, and now the wire color picker's) needs
**one-time `window`-level mousemove/mouseup listeners driven by a
module-level "what's being dragged" flag**, registered ONCE outside any
render function - not a fresh pair attached inside the render function
itself. The render function only wires the element's own `mousedown`
(safe to re-attach every render, since the old element and its listener
get garbage collected together when innerHTML rebuilds); mousemove/
mouseup have to be outside because `window` itself never gets rebuilt,
so listeners attached there on every render just accumulate forever. The
wire picker's own instance (`wireColorDragActive`) has one extra wrinkle
the other three don't: it can be opened from either the sidebar or the
header, so it also tracks `wireColorDragContainer` (whichever DOM tree
it was opened in) so the drag listeners know which one's `#wireSvSquare`
to keep updating regardless of where the mouse ends up. If you add ANY
new drag interaction, check this pattern first (search for
`colorDragTarget`, `svDragActive`, `configureColorDragActive`, or
`wireColorDragActive` for the four reference implementations) rather
than reaching for `element.addEventListener('mousemove', ...)` inside a
render function.

### Pairing
BT is the TCP **client** (IT is the server, listens on `localhost:47932`).
Handshake: BT sends `{type:'hello', app:'battle-tracker'}`, IT replies
`{type:'hello-ack', app:'initiative-tracker'}`. Status pushed to the
renderer via IPC, shown as a colored dot (grey/green) in each app's
Settings/Connections area. Retries every 3s on failure. This is GREEN
plumbing but currently has no GREEN *features* actually built on top of
it yet - it just lights up the dot.

### What's explicitly NOT built yet
Creature layer (not started - Configure's item-order comment already
reserves its place after Logic, but nothing reads or writes it).
Spawn/Spells/Play tabs (registered in the tab-switching system, no
content). Configure Edit mode's editing beyond rotation and color (no
delete/move/duplicate from the Configure panel itself - though the
Select tool's Arrange mode now covers moving, from a different tool).
**The Wire graph has no runtime effect at all yet** - wires can be built,
edited, colored, and inspected from all three surfaces, but nothing
actually WALKS the graph or propagates a state change through it; that's
Play mode's job specifically, still unbuilt. Select tool's Interact mode
only toggles the literal thing clicked (lever/door's own on/off state),
never anything downstream of it via a wire. **None of the five Logic
piece types have any action associated with them yet** (Switch, Break,
Hide, Recolor, Move - all exist as placeable, wireable pieces with no
behavior; see Section 9.5's "Logic pieces" for why the three newest
ones' icons already hint at intended future behavior that isn't built).
Chest/stairs/item (sack) have no activation behavior at all, in either
Interact mode or anywhere else - only lever and door currently do
anything when interacted with. A switch's `switchTriggers` dropdown
(same-location-only, category-only, predates the real Wire system) still
has no runtime effect either - same status as before, unrelated to
whether the newer Wire system works. Wire Stage 2 sub-variants
(originally scoped as three build stages - sidebar, header, map - all
three now exist, so this is actually complete, not a gap; noting it here
only because a resumed conversation may still be looking for a "Stage 3"
that's already done). Everything from the original
`BATTLE-TRACKER-DESIGN.md` past what's described above - multi-floor
maps, the block-based spell/logic engine, 3D targeting geometry,
objects-via-repeating-triggers, the full IT sync contract beyond the
bare pairing handshake. Don't assume any of that exists just because the
design doc describes it in detail.

## 9.7. Testing This Sandbox — Lessons Learned

Chased down several apparent bugs this session that turned out to be
testing-environment or test-script artifacts, not real problems. Worth
knowing these patterns before spending a lot of budget re-discovering
them:

- **A tool's own button disappears from the DOM once a DIFFERENT tool is
  active** (see the Tools section above) - `querySelector('[data-tool=
  "X"]')` returning null usually means a different tool needs deselecting
  first, not that the button is broken. Always deselect the current
  `.header-tool-btn.active` before trying to reach a different tool's
  button in a script.
- **A swatch's `.active` CSS class is not a reliable proxy for "is this
  the currently `selected` item"** once a non-Place tool has been active
  in between - it also requires `activeTool === 'place'` to render as
  active at all (see the swatch-click gotcha in Section 9.5). A test that
  re-clicks a swatch because it doesn't LOOK active in the DOM can
  accidentally trigger the app's real "click an already-selected swatch
  to deselect it" toggle, corrupting `selected` for everything that
  follows. This produced a long false-alarm chase this session - when a
  test result contradicts what the code review says should happen,
  suspect the test's own click sequence before the app.
- **The on-screen cell/edge pixel size is not reliably guessable from
  window dimensions alone**, and small, plausible-looking offsets (10-50
  px) can all resolve to the SAME edge due to a generous hit-tolerance
  zone, while other offsets land on nothing at all. The one coordinate
  that's repeatedly proven reliable across many sessions is the exact
  canvas center (`canvasRect.x + canvasRect.width/2`,
  `canvasRect.y + canvasRect.height/2`) - it reliably resolves to a
  horizontal edge. For a second, DIFFERENT edge or a vertical edge,
  don't guess a small offset - either empirically probe first (place
  something at a few widely-spaced candidate offsets, screenshot, and see
  what actually landed where) or accept a wide, unambiguous offset
  (100+ px) rather than a precise-looking small one.
- **A stale Xvfb lock file (`/tmp/.X99-lock`) silently blocks a fresh
  Xvfb instance from binding the same display** after a prior session's
  Electron/Xvfb pair was killed uncleanly - the symptom is CDP simply
  never coming up (connection refused indefinitely), not an obvious error
  message pointing at the lock file itself. `rm -f /tmp/.X99-lock
  /tmp/.X11-unix/X99` before each relaunch avoids this.
- **Everything (Xvfb, Electron, the CDP connection) has to be launched
  and used within ONE bash tool call** - each tool call is its own
  process tree, and backgrounded processes from a previous call don't
  survive into the next one. Launch Xvfb, launch Electron with a polling
  loop waiting for CDP to actually respond (a fixed `sleep N` is
  unreliable - startup time varies), then run the actual check script,
  all in the same `(...)` subshell, in the same tool call.
- **`localStorage` persists across test runs on the default Electron
  partition.** A test that checks "is the recents list empty" can fail
  for reasons that have nothing to do with the app - it's seeing state
  left over from an earlier test in the same session. Use
  `partition: 'persist:something-' + Date.now()` per test when you need a
  guaranteed-clean slate (this is also the ONLY way to properly verify
  persistence itself - open one window, do something, close it, open a
  SECOND window on the SAME partition, confirm the data's there).
- **`getImageData`-based pixel checks can lag behind real state**,
  sometimes by more than a typical few-hundred-ms test wait. Before
  concluding a visual bug is real: (1) check the underlying DATA directly
  (Map sizes, computed paths, state variables) via temporary
  `console.log` - if the data's right, the bug (if any) is in
  rendering/timing, not logic; (2) try a plain manual extra
  `requestRedraw()`-equivalent call after the fact - if that alone fixes
  it, the redraw scheduling just didn't fire within your wait window,
  not a drawing-logic bug; (3) if still unsure, wait several real seconds
  (not milliseconds) with zero intervention before concluding. This
  session hit a case where undo-then-line-mode-drag appeared totally
  broken (zero wall pixels, confirmed even via `capturePage` screenshots)
  but a 3-second unassisted wait showed it rendering correctly the whole
  time - a `requestAnimationFrame` scheduling delay specific to hidden
  (`show:false`) windows under Xvfb, not a bug a real, visible, focused
  user window would ever hit.
- **`console.log` calls, when a `console-message` listener is attached on
  the Node side, can themselves measurably interfere with animation-frame
  timing** - a test that adds debug logging to diagnose a timing issue
  can make that exact issue reproduce more or less often. Remove all
  debug logging before drawing a final conclusion about a timing-
  sensitive bug, and re-verify clean afterward.
- **`window.dispatchEvent(...)` vs `element.dispatchEvent(...)` matters.**
  Dispatching on `window` only fires listeners attached to `window`
  itself, not descendant elements' own listeners (no "downward"
  propagation) - the opposite direction from bubbling. If a synthetic
  click/mousedown on a specific button/element isn't triggering its own
  handler, check you dispatched on that element, not on `window`.
- **Middle-click and other non-default buttons need an explicit `button`
  field** in the synthetic `MouseEvent` (`button: 1` for middle, `2` for
  right) - omitted, it defaults to `0` (left) regardless of intent.
- When a headless test result contradicts a result you're confident
  about from earlier verification, don't just accept the new one -
  isolate the *specific* difference between the two test setups
  (different wait time? different partition? debug logging present?)
  before concluding something regressed. Several "regressions" this
  session turned out to be exactly this.
- **A structure/logic click test needs the cell's actual CENTER, not
  just any point that happens to fall within the right cell.** This bit
  hard while verifying the Select tool's Arrange mode: `findGrabbableAt`
  correctly uses a hit RADIUS for structures/logic (0.35/0.18 of a cell,
  from center - see Section 9.5's "Select tool"), so a click that
  resolves to the right `(col,row)` but lands even slightly off-center
  can miss a real structure entirely while a plain Configure click at
  that exact same pixel still finds it fine (Configure has no radius
  check at all - it just resolves to whatever cell the point falls in).
  Confirmed this precisely once by computing the actual world-space
  distance from center (12 units off against an 11.2-unit radius - a 2%
  miss) via temporary `console.log`s in `findGrabbableAt` itself, not by
  guessing. When a click that "should" hit something doesn't, check
  whether the target has hit-radius logic before assuming a placement or
  gesture bug - compute the click as `rect.left + (col+0.5)*32,
  rect.top + (row+0.5)*32` (assuming default zoom 1/offset 0, both true
  on a fresh launch) to land dead-center and rule this out. **Doors need
  the opposite treatment** - they're edge-keyed, not cell-keyed, so a
  cell-center click won't place or find one at all; use an edge point
  instead (`rect.left + col*32, rect.top + (row+0.5)*32` for a vertical
  edge between columns `col-1` and `col`). Several apparent wire/arrange
  failures in the same debugging session turned out to be exactly one or
  the other of these two coordinate mistakes, not real bugs - isolate
  with a minimal single-action repro and, if still unclear, temporary
  `console.log`s at the exact decision point (which structure exists at
  a key, what a radius check actually returned, etc.) before concluding
  the feature itself is broken.

## 9.8. The September 2026 Sandbox-Reset Incident — Read This First

**What happened**: partway through a long-running Battle Tracker
conversation, this project's working directory (`BattleTracker-source`)
came back completely pristine — none of that session's own established
fixes were present (Configure header controls, a wall-deletion bounding-
box fix, an Arrange-drag highlight fix, Logic's delete-hover behavior, a
text-selection guard on the app's own logo, a Place-tool double-click
fix, Select tool text/cursor fixes, Configure placeholder text — a
non-exhaustive list reconstructed from conversation history, not a
verified-complete one). This was discovered only because the code was
re-read before continuing and didn't match what should have been there
— **not because anything announced the reset**. The person's own
read, going into this: "you just had an update today, and that's what
made this whole disaster" - plausible, but **unconfirmed from this
session's side**; there's no tooling available here to inspect
platform-level infra changes, so treat this as the person's working
theory, not a verified root cause. What IS verified: the directory came
back empty of prior work, full stop, regardless of why.

**Why this was recoverable at all, and why it barely was**: the only
reason the session could continue was that the conversation transcript
itself (compacted summaries plus, where still available, the raw
session log) described what had been fixed and roughly how, well enough
to re-implement each fix from scratch by reasoning about the pristine
code fresh. This is slow, and it is not guaranteed to be complete or
correct — a fix that was made but never clearly re-described in a
compaction summary is at real risk of being silently lost. **If you're
reading this because the code doesn't match what Section 9.5 describes,
that's the scenario this section is warning about** - don't assume the
person is confused about what's built; check whether the file on disk
actually has what this document says it should, before doing anything
else.

**The actual root cause of "barely recoverable"**: this project has **no
git repository** (confirmed: `git status`/`git log` fail outright in
`BattleTracker-source`, unlike Initiative Tracker which has a real,
if under-pushed, GitHub remote — see Section 2/Section 6's own git
notes for IT). There is no commit history, no local `.git`, and — as
far as could be determined this session — no pushed remote either. A
project with real version control survives a sandbox reset trivially
(`git clone` or even just `git status` showing nothing uncommitted was
lost). This one did not have that safety net, and paid for it in a slow,
error-prone, "reconstruct from memory" recovery instead of an instant
one.

**What to actually do about this, if you're able to**:
1. **Initialize git in `BattleTracker-source` and make it a real habit
   to commit after every verified batch of work**, the same discipline
   Section 6.5 already asks for on the build side. A local `.git` alone
   is a huge improvement over nothing, even with no remote.
2. **Ask the person whether a GitHub remote should exist for this repo**
   (a sibling to `Initiative-Tracker`, e.g. `Battle-Tracker`) and, if so,
   whether one already does and just hasn't been pushed to, or whether
   one needs creating. Don't assume either way - confirm.
3. **Until real version control exists, treat whatever source zip or exe
   was most recently delivered to the person as the only durable
   backup of this project.** If a reset happens again before git exists,
   the person having a recent copy in their own downloads may be the
   only way back, faster than re-deriving fixes from a compacted
   transcript a second time.
4. At the start of any new session on this project, **don't assume
   continuity — verify it.** A quick check (does a known recent fix's
   code actually appear where Section 9.5 says it should?) costs very
   little and catches this exact failure mode immediately instead of
   partway through unrelated work.

**A separate, still-unresolved issue from the same session, worth
flagging alongside this**: the person recalled receiving portable `.exe`
builds (~68MB) directly in chat from earlier sessions, but this
session's file-delivery tool enforces a **hard 30 MiB per-file cap** and
flatly refuses anything larger — confirmed by the tool's own explicit
error text, not inferred. Shrinking the exe (trimming bundled Chromium
locale files via `electronLanguages` in `package.json`'s `build` config)
only got it from ~71MB to ~65MB - nowhere near enough, since the bulk of
a portable Electron exe's size is inherent Chromium/Node binaries that
don't meaningfully compress or trim further without dropping Electron
features. Re-zipping an already-built portable exe was tested directly
and confirmed useless (`zip -9` reported `deflated 0%` - NSIS-portable
executables are already internally compressed). **The practical
resolution**: deliver the source code instead (a few hundred KB, trivially
under any limit) plus build instructions (`npm install` && `npm run
dist`, Windows-native; Wine needed if building from Mac/Linux), and let
the person build their own exe. **Whether a genuinely larger direct-exe
delivery path exists in some other session/interface was never
confirmed either way** - don't assume the 30 MiB cap has always applied,
but don't assume a way around it exists either unless the person
describes exactly how they received a larger file before.

## 10. Roadmap & Where This Is Headed

The person's stated direction, in his own words from earlier in this
project: **not a superapp** - a constellation of separate, focused
companion apps that sync with each other when running together, rather
than one app that does everything. He explicitly rejected the "everything
in one app" framing.

**Initiative Tracker itself** is largely feature-complete against the
original closing-out list; this session was almost entirely QoL fixes and
polish (package editing rework, the ledger resize/lock/responsive work,
Dex-Init auto-linking, the awaiting-creature picker, a Change Log tab) plus
real bugfixes for regressions those same features introduced. **Reset to
base library/features** is still the one original item never built (scope
was never fully decided — just the 5e Index, or Trackers/Settings too? —
worth clarifying before building it, if it comes up again).

**Battle Tracker** (the second companion app) is no longer just a design
doc — see **Section 9.5** for its full current state. It's a working
Electron app: grid battlemap with pan/zoom, wall/texture/structure/logic
placement with Select/Place/Delete/Paint/Configure tools, five structure
types (stairs, chest, sack, lever, door - three of them built from the
person's own hand-designed SVG art) with per-instance rotation (textures
rotate now too), five Logic piece types (Switch, Break, Hide, Recolor,
Move - all cosmetic/placeable only, no runtime behavior on any of them
yet), undo/redo, a
full HSV color system covering walls/textures/structures/wires alike
(primary/secondary paint colors, persisted recents/favorites, and a
fourth independent picker instance for wires specifically), a Configure
tool with two modes - Edit (inspect/rotate/recolor what's already placed)
and Wire (connect items together across three separate creation
surfaces: sidebar, header, and a right-click map menu) - a Select tool
for moving already-placed items around or toggling a lever/door directly
(outside of Play mode, which doesn't exist yet), and a live TCP pairing
handshake with Initiative Tracker. The Wire graph itself has no runtime
effect yet - that's Play mode's job specifically. The original design
doc's *later* ideas (multi-floor, the block-based spell/logic system,
3D-aware targeting, objects-via-repeating-triggers) are **not built
yet** — Section 9.5 says exactly what exists vs. what's still just
designed. If continuing Battle Tracker work, read Section 9.5 in full
before touching code; if the original design doc
(`BATTLE-TRACKER-DESIGN.md`) is still around, it's still the source of
truth for the unbuilt parts.

**After that, Adaptive Music Manager** - likely built last. Import audio
authored elsewhere, construct movement between sections/riffs on command,
assign tracks/transitions to creatures so combat state can drive music
automatically. The person has real domain expertise in adaptive music
specifically — trust his creative/musical direction here.

**The sync layer** between apps: each app optionally hosts a small local
WebSocket server that sibling apps connect to when present; features
"light up" when a companion is detected, and every app still works
completely standalone without it. Peer-to-peer, not a central hub app.
Discovery via trying known ports first, falling back to a shared
discovery file if needed. Full detail (message envelope shape, field-
ownership-by-domain rules, the entity-id-as-shared-schema decision) was
worked out in conversation but may not be written down anywhere durable —
if this becomes relevant, check whether a design doc exists before
re-deriving it from scratch.

**The filter he uses for "does this belong in the compiler or a companion
app"**: does the idea need something the compiler fundamentally doesn't
have (space for a battlemap, real-time audio), or is it just a convenience
that happens to live near a bigger idea. Apply this filter before assuming
a request belongs here.

## 11. Working With This Person

- **Game design major, not a programmer** - this explains his precise,
  systems-level way of specifying features (four-letter tracker codes with
  exact color semantics, a save-mechanic decomposed into reusable
  roll/compare/branch primitives, "think of this whole feature as X," a
  battlemap spell system deliberately scoped to a small composable block
  vocabulary). He's handing you fully-formed mechanical specs more often
  than vague feature requests - take them literally and precisely, they're
  usually exactly right. When a spec is genuinely ambiguous (rare), state
  the most reasonable reading and proceed rather than blocking on it — but
  flag the assumption clearly.
- **Wants genuine verification, not confident assertion — but also wants
  speed.** These aren't in tension as much as they might seem: see 6.5.
  Real logic gets real verification (actual code paths, realistic data);
  cosmetic/pixel-level polish gets one honest check, not five. Screenshot
  and measure via CDP when you can; when you can't (the HTML5 drag-and-drop
  limitation), say so plainly rather than letting a confident tone imply
  more certainty than you have.
- **Notices small things and cares about them** - button alignment down to
  single pixels, exact wording changes, spacing that "matters a lot" even
  when it sounds minor. Treat these requests with the same rigor as
  feature work, not as an afterthought — but see the point above about not
  over-rotating on pixel-perfect certainty for these specifically; one
  honest, careful attempt beats several increasingly-precise ones.
- **Primary OS is Windows**; has a Mac available but dislikes developing on
  it. Default to assuming Windows unless he says otherwise. Expect
  cross-platform rendering differences to surface real, previously-invisible
  issues on his machine even after a clean pass here (see Section 7,
  lesson 1) — this isn't a sign the verification process failed, it's an
  inherent limitation of this sandbox that's worth naming rather than
  being surprised by each time.
- **Wants explicit control over version numbers now.** Don't auto-bump; see
  the note at the top of this document.
- **Values being told the truth about mistakes**, including this session's
  own — a fix that didn't fully work, a version-numbering habit that
  drifted past what he'd actually authorized, a changelog built without
  first confirming whether a real one already existed. Owning these
  plainly and re-diagnosing properly (rather than quietly patching around
  them or downplaying them) has consistently gone better than any
  alternative, across every session on this project so far.
- **On Battle Tracker specifically**: comfortable with iterative,
  "get the feature down, polish later" phasing when he says so explicitly
  (e.g. building the color picker's core mechanics before its visual
  cleanup, or Configure's selection-only pass before any editing
  functionality) - take that literally, don't polish or add scope
  preemptively when he's said not to yet. Gives precise, measurable UI
  specs the same way he does for IT ("expand by about a sixth," "in line
  with the edge of the sliders," exact button-size matches between two
  specific elements) - these are usually worth verifying with real pixel
  measurements (`getBoundingClientRect`), not just a visual glance, the
  same rigor as IT's pixel-level requests. Right-click as a secondary/
  contextual action (favorite a color, later remove a favorite) is an
  established pattern he likes - reach for it again for similar
  "secondary action on the same object" needs rather than inventing a new
  UI element each time. **This prediction played out directly**: the map
  gained a real right-click context menu later in the same overall arc
  (Wire mode's item picker), explicitly built generic/reusable rather
  than wire-specific from the start, per his own instruction ("we will
  find more use for the right click menu later... structure it to be
  repurposed elsewhere"). Also willing to explicitly REVERT a completed
  simplification once he'd seen it in practice and preferred the older
  approach (the wire color picker: native `<input type="color">` first,
  then back to the custom SV-square picker on request, applied
  consistently everywhere colors are picked) - treat this the same as any
  other direct instruction, not as a sign the simplification was a
  mistake to have tried.
- **Designs his own icon/sprite art** (Inkscape/Figma) and hands over raw
  `.svg` files expecting them actually used, not treated as reference to
  redraw from - see "Custom SVG art" in Section 9.5 for the porting
  process. He already matches the app's exact hex colors before sending a
  file over; don't second-guess or substitute a different value. Expect a
  follow-up sizing/stroke-weight pass after the first landing (his source
  canvases run at a very different scale than the hand-built icons) -
  that's normal iteration, not a sign the first attempt was rushed or
  wrong.
- **A long, confusing debugging chase this session turned out to be a
  test-harness mistake, not a real bug** - re-clicking an already-selected
  swatch (because its DOM `.active` state looked wrong across a tool
  switch) silently deselected it via the app's own working toggle
  behavior. Worth internalizing generally: when several rounds of
  targeted diagnostics all point at one specific, narrow mechanism rather
  than the feature being tested, seriously consider that the test itself
  is the thing with the bug before concluding the app is broken - and say
  so plainly once found, the way this was, rather than quietly moving on.
