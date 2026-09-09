# PCB live multiplayer sync

**Status: in progress.** Started 2026-08-31. First slice (diff-based document
sync + live drag preview) built and partially verified; selection/grab locking
not started.

For the target design across the whole app, in plain terms, see
`multiplayer-architecture.md`. This file is the day to day log of the PCB
editor's own progress against it.

## The constraint that shapes everything here

This is going online. **We cannot send the whole board after every change.**
A real board file is multiple megabytes; a network transport (eventually
Supabase Realtime or similar, not just same-browser `BroadcastChannel`) has to
carry each edit as something proportional to the edit, not to the document.
Every design decision below exists to satisfy this one constraint.

## Why not replay commands

Correction, 2026-09-01: an earlier version of this section claimed "the
schematic editor's live sync rides an `EditCommand` bus". **That is wrong**,
and it is worth stating plainly because it made the PCB side look like the
odd one out when it is not. Schematic sync
(`SchematicEditor.tsx`, the effect near `lastKnownText`) serializes the whole
active sheet on a 400ms debounce and publishes it as `model-changed` text,
which the receiver swaps in wholesale via `applySheetDocument`. That is the
same last-writer-wins whole-document push the PCB uses as its *fallback*. On
the wire, neither editor is atomic, and since `pcb_diff.ts` the PCB is the
more granular of the two.

`EditCommand` is real, but it is the schematic's *local* edit/undo primitive
(`eeschema/src/tools/command.ts`: `apply(doc)`, `invert(before)`,
`composeCommands` = KiCad's `SCH_COMMIT`), and it never reaches the transport.

The PCB has no local equivalent: edits go through `commitBoard` at 53 call
sites, each handing over a whole new `Board`, with undo a stack of whole-board
snapshots (`undoRef`). Giving it one would be worth doing for other reasons
(see Outstanding: a commit that knows what it touched is what incremental
scene patching needs), but it would not make command *replay* safe over the
wire: the router's push-and-shove and zone fill are floating-point geometry
with no guarantee that "the same operation" replayed on a receiver's board
reproduces byte-identical results, and silently diverging two peers' boards is
worse than being slow. Diffing the result stays the right call regardless.

## The approach: diff the result, not the operation

Every PCB item type carries its own `uuid` and its own `source` SList
(lossless round-tripping is already a hard requirement here for file
fidelity), so an item is a self-contained, uuid-keyed unit, safe to diff and
safe to splice into a *different* board wholesale. `designer/src/sync/pcb_diff.ts`:

- `diffCollection` / `diffBoard`: uuid-keyed diff between two `Board`s.
  Returns `undefined` for "no change" and a distinct `UNSAFE` sentinel when
  some item lacks a uuid, so the two cases are never conflated (an earlier
  draft of this collapsed them into one `null` and broke almost every edit).
- `applyBoardPatch`: splices a patch into a receiver's own board object by
  uuid, correctly even when sender and receiver boards are different
  references (confirmed against a real fixture: patch computed against one
  loaded copy, applied to a separately-loaded copy of the same file, lands
  correctly).
- Falls back to whole-board text sync (`model-changed`, via a Web Worker,
  `pcb_sync_pool.ts` / `pcb_sync_worker.ts`, since serialize/parse measured
  ~80-160ms synchronous on a real 7.6MB board) only when a touched
  collection is `UNSAFE`.

Measured on a real board: a one-footprint move produces a ~71KB patch against
a 7.6MB board (107x smaller), not touching any unrelated collection.

## Live drag preview

A move/drag gesture broadcasts its own uncommitted state before the 400ms
debounced `board-patch` lands, so peers see the drag happen rather than
snapping at the end:

- `live-move-start`: one-time snapshot of the dragged items, at drag start.
- `live-move-delta`: cheap, throttled (~80ms) position updates while the
  gesture continues.
- `live-move-end`: clears the preview; only sent for a zero-delta/cancelled
  gesture, since a real move's own `board-patch` replaces the preview
  cleanly when it lands.

Reused the existing `moveSceneRef`/`moveDeltaRef` overlay mechanism (a small
scene drawn on top of the base scene, translated by a delta at draw time)
that local drags already use; `draw()` needed no changes, since its
composite logic was already generic to "whose delta is this."

Router drags (push-and-shove) are explicitly out of scope for live preview,
since that gesture rebuilds stretched geometry every frame even locally.

## Bugs found and fixed so far

- **`diffCollection` conflating "no change" and "unsafe"**: caught before
  any live test ran.
- **Ghost item + full-board flicker on every drag**: the live-move overlay
  was drawn on top of a base scene that still had the original item in it.
  Fixed by pulling the dragged items out of the base scene once at
  `live-move-start` (`boardMinusUuids`), mirroring what local track-drag
  already does.
- **`emptyBoardLike` / `subsetBoardItems` never filtered `dimensions` or
  `images`**: a genuine pre-existing bug in Ziro's own PCB engine, not
  introduced by this work, found while chasing "dragging a footprint drags
  all dimensions." Confirmed via a third, correct sibling
  (`emptyClipboardBoard` in `pcb_clipboard.ts`) that did include both
  fields. Fixed both functions; regression-tested via `git stash` (2 of 3
  new tests failed against the pre-fix code, confirming they actually catch
  it).
- **Ghost item on *any* remote edit, not just drags**: the fix above only
  covered the four collections a plain drag touches. The general
  `board-patch` apply path (any committed remote edit, such as rotate,
  delete, or nudge, not just drag) never removed the patch's *prior* items
  from the base scene before drawing the new-position overlay, so every
  non-drag remote edit ghosted a stale duplicate until the full scene
  rebuild caught up ~200ms+ later. Fixed with `boardMinusPatch`, the
  general form of `boardMinusUuids` covering all twelve item collections a
  `BoardPatch` can touch.
- **The receiver was on the slow drag path all along**: the real cause of
  both reported symptoms, found only after the two attempts below failed to
  change what the user saw. A local drag is smooth because of
  `beginMove`'s in-place branch: `PcbGl.moveItems` shifts the dragged items'
  vertices inside the retained buffer (`Scene.itemRanges`), so nothing is
  recompiled, nothing is re-recorded, and there is no second copy anywhere.
  The remote path never had that branch. It always took the *fallback*:
  compile a base scene with the items removed, compile an overlay, offset
  the overlay per frame. `buildBoardScene` costs a full board compile
  whether it excludes one item or none (~220ms here; the GPU re-record it
  forces was measured at 1228ms on coldfire). That is both symptoms at once:
  what is on screen is the raster/buffer built *from* `sceneRef`, so until
  that compile lands the base still shows the item where it was while the
  overlay draws it where it now is (**the ghost**), and the compile landing
  is itself a whole-board repaint (**the flicker**). Fixed by giving the
  receiver the same in-place branch on the same conditions
  (`remoteMoveTargetIds` bridges the wire's uuids to the `kind:index` ids
  `itemRanges` is keyed on), keeping the overlay only as the fallback it
  already is locally. `board-patch` then returns early too: after an
  in-place drag the buffer already shows the committed position, so the
  preview overlay and the `boardMinusPatch` exclusion are both pure waste.
- **Two earlier attempts that did NOT fix it**, kept here because both
  looked right and neither moved the needle:
  live, after the two fixes above, as "dragging a component flickers the
  other tab and leaves a ghost." `boardMinusPatch`/`boardMinusUuids` are
  correct about *what* to exclude, but both were called through
  `buildBoardScene` synchronously, inline, before the very first
  `requestDraw()` of the gesture, and `buildBoardScene` over "the whole
  board minus a few items" costs the same as compiling the whole board
  (the ~220ms figure above). `live-move-start` paid that once per drag,
  at the start; the `board-patch` apply path paid it a *second* time on
  top of `commitBoard`'s own rebuild at the end, since the two are
  computing near-identical scenes. Net effect: every remote drag froze
  the receiving tab twice, for the same ~220ms each time, with a paint in
  between, which reads as flicker, not as a hang. Fixed by reordering
  both sites to match `startOverlayMove`/`scheduleBaseWithout`'s existing
  split for a *local* drag: show the cheap overlay first
  (`requestDraw()`), then defer the expensive exclusion with
  `setTimeout(fn, 0)` rather than running it inline. `baseRebuildRef`'s
  generation token (already used by `scheduleBaseWithout`) makes the
  deferred call a no-op if a newer drag, or `commitBoard`'s own
  `rebuildScene`, lands first: `rebuildScene` bumps the same counter as
  its first line, so the ordering race resolves safely either way. This
  does not eliminate the `board-patch` path's two full rebuilds (that
  needs incremental scene patching, see Outstanding), only the part
  where the first one blocked the first paint.

## Fixed after live testing (2026-09-01, user's own pass)

Confirmed working well in real two-tab testing. Three more bugs surfaced and
were fixed in that pass, none caught by the in-browser measurement above
because none of them are stalls: they're small correctness gaps in the
in-place path:

- **The sync subscription's `requestDraw` was a stale closure.** The
  `useEffect` that sets up `transport.onMessage` depends only on
  `[projectName]`, so the `requestDraw` it captured at mount is whatever that
  function's identity was then. Later re-renders (view options, `objects.*`
  toggles) create a new `requestDraw` via `useCallback`, and the subscription
  never sees it. Every call site inside the sync handlers now goes through
  `requestDrawRef.current()` instead, the same indirection `draw()` itself
  already used for this exact reason.
- **Release-time ghost at the penultimate position.** `live-move-delta` is
  throttled (~80ms), so its last broadcast can be one or more cursor samples
  behind the sender's actual mouse-up point. `moveEnd` now publishes the
  exact final delta as one more `live-move-delta` before calling
  `commitBoard`. `BroadcastChannel` preserves order, so the peer's buffer
  reaches the drop position before the committed scene replaces it, instead
  of sitting at a stale position for the gap.
- **A receiver's own selection outline sat at the stale position over
  someone else's drag.** If a peer is moving an item this tab *also* has
  selected (locally, unrelated to the move), the local selection-highlight
  pass (`selSceneRef`, drawn from `board`, not from the translated buffer)
  kept drawing at the pre-drag position. `remoteSelectionConflict` suppresses
  that pass (and edit handles) for exactly the items a live remote move is
  touching, for exactly the duration it's touching them.

Also landed in the same pass: `route_tool.ts` now precomputes obstacle hulls
once per interactive routing session (`routeObstacleHulls`) instead of once
per cursor frame, a router-drag performance fix found while testing, not a
sync bug, but worth noting here since it's easy to mistake for one if router
drags still feel slow after everything above.

## Grab/selection locking (2026-09-01)

The Outstanding item below is now done for the two cases the original ask
named: "if one client grabs OR selects an item, it should lock from
everyone else until released", with one scoped exception (router drags,
below).

**Correction to the partial version of this section** (written earlier the
same day): it claimed "nothing in the codebase currently computes" a
per-item bounding box, checking only `boardEdgesBoundingBox` and
`BoardScene.bbox` (both whole-board) before concluding a visual indicator
would need new infrastructure. Wrong: `edit-board.ts` already has
`boardItemBBox` (a switch over all fourteen `BoardItemKind`s, `boardSelectionBBox`
already unions it over a selection) and `PcbEditor.tsx` already uses
`boardSelectionBBox` three times for local selection's own bounding box.
Found by actually checking before writing the limitation down a second time,
which is what should have happened the first time.

**The lock**, in `beginMove`: refuses the whole gesture if any item in the
(post-pad-promotion) selection is either
1. named in `remoteAffectedRef` while `remoteLiveMoveActiveRef` is true,
   meaning a peer is *actively dragging* it right now (`remoteAffectedRef`
   is set for both the in-place and overlay-fallback branches at
   `live-move-start`; it was in-place-only in an earlier pass, which would
   have left the fallback path, no WebGL2, or a board with a reference
   image, unlockable), or
2. present in any connected peer's broadcast selection
   (`remoteSelectionsRef`, resolved against this board with
   `boardIdsForUuids`), meaning a peer merely has it selected, not moving it.

Whole-gesture, not per-item: a partial grab that silently dropped the locked
members would move a different selection than the one the user grabbed.

**The wire format**: PCB now broadcasts `{ kind: 'selection', refs }` on
every local selection change, `refs` being **uuids**
(`boardItemUuids(board, selection)`), not the `kind:index` ids `selection`
itself holds, since those only mean anything against this tab's own board,
the same problem `pcb_diff.ts` solves for edits. `boardItemUuids` /
`boardIdsForUuids` (new, `edit-board.ts`) are the send/receive halves,
covering all twelve `BoardPatch` collections (not just the four `beginMove`
moves), deliberately excluding `pad`/`fptext`, which have no `uuid` of
their own here, so a peer's pad-only selection rounds up to nothing rather
than mislabeling it as the whole footprint. A peer that vanishes without
clearing its selection (a crash) self-heals once presence's heartbeat
eviction removes it from the roster, not instantly, but bounded.

**The visual**: a dashed box in `REMOTE_CURSOR_COLOR` around each peer's
resolved selection, drawn in `draw()`'s existing 2D overlay pass right next
to the remote-cursor dots, deliberately a box, not a brightened redraw like
this tab's own selection (`selSceneRef`), so the two read as different
things at a glance. Excludes whatever `remoteAffectedRef` currently names
while that peer's drag is live, since that item's bbox is computed from
`boardRef`'s still-pre-drag position (nothing shifts it the way `moveItems`
shifts the GPU buffer) and would visibly lag the part sliding across the
screen: the drag itself is already the stronger cue there.

**Router drags (`beginTrackDrag`) still have no guard.** A footprint drag
in `'drag'` mode pulls in `connectedTrackEnds`, so a remote *footprint* drag
is protected end-to-end; a remote plain-track push-and-shove is not. Router
drags were never synced live either way (see "Live drag preview" above), so
this is consistent with existing scope, not a new gap.

Verified two ways. Unit: `qa/unittests/pcbnew/edit-board.test.ts` has real,
executable tests for `boardItemUuids`/`boardIdsForUuids` (uuid round-trip
through two boards with different index orders, all twelve collections, a
uuid this board doesn't have resolving to nothing rather than throwing, a
pad/fptext id contributing nothing), mutation-tested (shrinking
`UUID_KINDS` to four kinds) and it fails the "all twelve collections" test as
expected. `qa/unittests/designer/pcb_move_ghost.test.ts` covers the
`PcbEditor.tsx` wiring the same way the rest of this file does (text-level
assertions, since this file can't be mounted), also mutation-tested (dropping
the selection half of the lock; sending raw ids instead of uuids) and both
mutants fail the new tests, typecheck green for both.

Live, in the browser, two real tabs (coldfire demo): confirmed the wire
protocol end to end by sniffing the `BroadcastChannel` directly: a real
selection change publishes `{kind:'selection', refs:[<uuid>]}`, an empty
selection publishes `refs:[]`. Confirmed the receive, resolve, bbox and
draw pipeline actually paints, by `getImageData` pixel-sampling the overlay
canvas for `REMOTE_CURSOR_COLOR`: found the dashed box's pixels exactly
where the resolved bbox predicted, on the canvas layer whose
`pointerEvents` is `none` (the overlay, not the interactive one). A
screenshot alone could not have confirmed this at PCB zoom levels; the box
is a few pixels of 1px dashed stroke, easy to miss by eye and exactly why
this method was necessary rather than optional.

**The lock refusing a same-item grab, now confirmed live too** (2026-09-01,
later the same day). The first attempt at this used synthetic
`PointerEvent`s computed from the resolved bbox to both start AND land a
drag on the exact locked item, too fragile: at PCB zoom levels a
few-pixel miscalculation (or the view moving between capturing the bbox and
firing the drag) lands the click on a neighboring track or footprint
instead, so two of these attempts "succeeded" at moving an unrelated item
and proved nothing about the lock either way.

The fix was to stop trying to hit a moving target with a synthetic drag,
and instead: (1) a plain **click** to select, which has real hit-tolerance
and a disambiguation menu, unlike a drag's exact start point, confirmed
correct via the properties panel matching the sender's selection exactly
(same reference, same position); (2) the **M** shortcut to start a move on
whatever is now selected, independent of cursor position entirely. On the
locked item (a peer's selected footprint): pressing M and then moving the
cursor produced no attached overlay and no live position readout. The
properties panel kept showing the item's original, unchanged position, and
`document.title` never gained the unsaved-changes `*`. The concern that "M"
might just be broadly inert was closed with a control test on an unlocked
via on the same tab: M there attached the item to the cursor immediately,
tracked it live (confirmed via the status bar's dx/dy readout changing with
the mouse), and had to be cancelled with Escape to avoid committing it. Same
tab, same shortcut, opposite outcome: locked refuses, unlocked works.

## What's verified versus what needs a live check

Verified directly: unit tests for the diff/patch logic against a real board
fixture, the worker round-trip, and the `subsetBoardItems`/`emptyBoardLike`
regressions (git-stash-proven). Typecheck, biome, and the full designer build
are clean after each change.

Measured on the receiving tab during a real two-tab drag of a footprint
(coldfire demo, `PerformanceObserver` on `longtask`): **zero long tasks for
the whole duration of the drag**, with the only heavy work (266ms, then
118ms, then 57ms) arriving after the drop, which is `commitBoard`'s own
`rebuildScene` plus the GPU re-record that follows it. Before this change
the same probe would have had to show a ~220ms stall at drag *start* as
well, since `live-move-start` called `buildBoardScene` synchronously.

**Not verified from the automation side**: the A/B for that claim. The
intended counterfactual (force `inPlace` false, re-run, watch the mid-drag
stall appear) never ran here: the synthetic pointer-down missed the
footprint and rubber-band-selected instead, so the mutant run proved nothing
and was discarded rather than reported as a pass.

**Verified live, by a human** (2026-09-01): confirmed working well across two
real tabs, including the three additional bugs and their fixes above. This is
the update that closes out the "needs a human eyeball" gap this section used
to end on.

## The lock outlived its own gesture (2026-09-01, later the same day)

Reported live, after "grab/selection locking" above shipped: it works, but a
peer freed from a lock still has to wait, the exact symptom the fix below
explains. `beginMove`'s guard checks `remoteLiveMoveActiveRef`, and nothing
cleared that flag on a **committed** move: `moveEnd` only published
`live-move-end` for the zero-delta case, on the reasoning (in the code
comment this replaced) that a committed move's own `board-patch` clears the
preview when it lands, so sending 'end' too would race it and flash the
pre-drag position for the gap in between. True for the *preview*, but the
same flag also gated the *lock*, and `board-patch` is on a 400ms debounce,
so every real move left the item locked for that debounce **on top of** the
gesture that had already finished, from everyone else's perspective.

Fixed by decoupling the two: `live-move-end` now always fires, immediately,
carrying a `committed: boolean`. The receiver drops the lock unconditionally,
but only touches the preview (undo the shift, rebuild the scene) when
`committed` is false: a committed move's own preview is left exactly alone,
still correctly showing the dropped position, for `board-patch`'s existing
in-place hand-off to take over when it lands. Same avoidance of the flash the
original code was protecting against, just scoped to the piece that actually
needed it.

Measured live (`BroadcastChannel` sniffed directly, coldfire demo, a real
committed move): `live-move-end` (`committed: true`) landed at **98ms**,
`board-patch` at **502ms**: the lock now clears **404ms** before the data
sync that used to gate it. Also unit- and mutation-tested in
`pcb_move_ghost.test.ts` (reverting either half, sending 'end' only for
`!hadRealMove`, or letting the committed branch fall through to the
preview-undo code, fails the new tests; typecheck stays green for both).

## Join-time snapshot (2026-09-02)

Requirement 2 in `multiplayer-architecture.md`: joining or reconnecting has
to bring you up to date automatically, not show a stale copy. Nothing in
the protocol did this before: 'presence' only ever exchanged identity
(peerId, view, sheetPath), never board content, and every peer converging
on the same state was a coincidence of same-browser tabs sharing one
IndexedDB, with autosave (its own 1s debounce, decoupled from the sync
layer entirely) as the only thing that made it look like this worked. That
assumption holds for `BroadcastChannel` and stops holding the moment a
peer is on a different machine, so it was worth closing before touching
cross-device transport at all, not after.

New payload: `{ kind: 'snapshot', toPeerId, sheetPath, text }`. Whole-board
text, the same shape 'model-changed' already uses, since a newly-arrived
peer has no prior state for `pcb_diff.ts` to diff a patch against. Every
already-connected tab watches 'presence' for a peerId it has not seen
before (the roster is the full list each time, not a join/leave delta, so
the diff against `knownPeerIdsRef` is done here, not by the transport) and
sends its own board, addressed to that one id. `BroadcastChannel` cannot
unicast, so everyone else on the channel sees the message too and ignores
it, `toPeerId` being the only thing that says who it was actually for.

Two races worth being explicit about, both resolved on the side of "never
silently overwrite," matching the fallback list in
`multiplayer-architecture.md`:

- **A user starts editing before the snapshot arrives.** `hasLocalEditRef`
  is set the moment `commitBoard` runs for a commit that is not itself a
  remote apply, checked before a snapshot is accepted at all. Losing this
  race means keeping your own board instead of the group's current one,
  wrong in a different way, but not a silent data loss, and not the
  common case.
- **A user starts editing while a snapshot already in flight is still
  parsing.** The parse is off the main thread and measured at ~160ms on a
  large board, long enough to matter. `deferToLocalEdit` (set only on a
  join-time snapshot, never on a genuine 'model-changed' edit, which must
  always apply) re-checks `hasLocalEditRef` a second time, right before
  the commit, not just at the moment the message first arrived.

Verified two ways. Unit: seven new tests in `pcb_move_ghost.test.ts`
covering the newcomer scan, the addressing check, both local-edit races,
and that `commitBoard` marks its own commits correctly, mutation-tested
(dropping the `toPeerId` check, dropping the second `hasLocalEditRef`
re-check) and both mutants fail the new tests, typecheck green for both.
Live: sniffed the `BroadcastChannel` directly across two real tabs. A
fresh tab's `hello` was answered with a `snapshot` addressed to its exact
peerId, sized like a real board (2.77MB on the coldfire demo), about
650ms later (the round trip through presence, serialize, and the
BroadcastChannel hop itself).

**Not verified live**: that the snapshot's *content* reflects a specific
edit made moments before the second tab joined. Landing a clean, isolated
edit on the one-pixel target this needed proved too fragile to automate
reliably here, the same class of limitation noted elsewhere in this file.
Confidence instead comes from the message-level proof above (correct
peer, correct timing, correct size) plus the fact that applying it runs
through the exact 'model-changed' parse-then-`commitBoard` path already
exercised extensively elsewhere in this file.

## The lock only covered drag and drop (2026-09-02)

Found while auditing the lock for the same class of gap as before: it only
ever guarded `beginMove`. Rotating, mirroring, flipping, deleting, grouping,
ungrouping or locking an item someone else had selected, or was actively
dragging, went through untouched. A peer's claim was real against one kind
of collision and invisible against every other, which is not what "lock"
was supposed to mean.

Fixed by pulling the check out of `beginMove` into two shared helpers,
`remoteLockedIds` (the same union it always computed: whatever a peer is
actively dragging, plus whatever any peer has selected) and `isRemoteLocked`
(true if any id in a given set is in that union), then calling
`isRemoteLocked` at the top of every command that transforms or removes the
current selection outright: `deleteSel`, `rotateSel`, `mirrorSel`,
`groupSel`, `ungroupSel`, `addToGroupSel`, `removeFromGroupSel`, `lockSel`
and `flipSelection`. `duplicateSel` is deliberately left unguarded: it reads
an item and creates a new one with a fresh uuid, never mutating the
original, so there is nothing here for the lock to protect.

Verified two ways. Unit: the existing `beginMove` tests were updated to the
new shape, plus new ones covering `remoteLockedIds` itself and, with a
single `it.each`, that all nine guarded commands call `isRemoteLocked`
before their own `commitBoard`. Mutation-tested: dropping the guard from
one command (`rotateSel`) and, separately, dropping the selection half out
of `remoteLockedIds`, each fails exactly the tests meant to catch it,
typecheck green for both. Live: rotating an unselected, unlocked item still
committed normally (Angle -90 degrees to 0, `Ctrl+Z`-reversible) with no
peer connected, confirming the new guard's false path introduced no
regression on the common case.

## The remote selection box lagged behind its own drop (2026-09-02)

Reported live: dragging a footprint hides the peer's box during the drag
(expected), but right after letting go, the box reappears at the *original*
position for about half a second before snapping to the correct one. The
item itself was already in the right place the whole time; only the box was
wrong.

The box's exclusion (see "Grab/selection locking" above) was gated on
`remoteLiveMoveActiveRef`, which drops to false the instant `live-move-end`
arrives, deliberately, since that is also what releases the grab/selection
lock promptly (see "The lock outlived its own gesture"). But for a
*committed* drag, `boardRef` itself does not catch up to the new position
until the debounced `board-patch` lands moments later, through the in-place
hand-off that finally clears `remoteInPlaceRef`. So for that whole gap,
`remoteLiveMoveActiveRef` said "safe to compute the box from `boardRef`,"
while `boardRef` was still lying about where the item was: the box came
back too early, and at the wrong place, then jumped once the patch
actually landed.

Fixed by widening the exclusion to `remoteLiveMoveActiveRef.current ||
remoteInPlaceRef.current !== null`, since `remoteInPlaceRef` is exactly the
signal for "boardRef is not safe to trust for these ids yet," and it
already stays set across precisely this gap by design. Also cleared
`remoteAffectedRef` in the overlay-fallback commit path (no WebGL2, or a
board with a reference image), which had no equivalent of its own: only the
in-place hand-off was clearing it, so a committed overlay-fallback drag
left stale ids sitting in `remoteAffectedRef` indefinitely, ready to
wrongly exclude a *later*, unrelated peer selection's box.

Verified two ways. Unit: two new tests, mutation-tested (reverting the
exclusion to `remoteLiveMoveActiveRef` alone; dropping the new
`remoteAffectedRef` clear) and both mutants fail exactly the tests meant to
catch them, typecheck green for both. Not verified live for this specific
fix: the two-tab, precisely-timed drag-and-release this needs has the same
automation limits noted elsewhere in this file, so confidence rests on the
unit and mutation coverage plus the same `remoteInPlaceRef` mechanism
already confirmed correct for anchors and pad labels (`inPlaceShift`)
earlier in this document.

## A plain Move skips the rebuild it does not need (2026-09-03)

The remaining half of "the drop still costs a full rebuild": a completed
in-place drag already has the GPU buffer showing the right picture (see
`inPlaceShift` above), and then `commitBoard` threw that away and recompiled
the entire board just to arrive back at the same result, both locally and
on every peer. Measured at 220 to 266ms on the boards this document already
cites, and it ran on every plain Move, not only a remote one.

Full incremental scene patching, the kind that also covers a rotated
footprint or a resized track, is a bigger job than this: `BoardScene` bakes
geometry into per-layer buckets, not per-item, so re-emitting one item's
shape in place would mean splicing a variable-size run into a shared buffer
and re-linking every other item's offsets after it. Not attempted here.

What a plain Move actually produces is narrower and does not need any of
that: `moveBoardItems` and the diff a remote plain Move's `board-patch`
carries are both pure translations of the moved ids, nothing else. For that
one case, the only things still wrong once `PcbGl.moveItems` has shifted the
retained buffer are exactly the screen-space passes `inPlaceShift` already
knows how to offset at draw time (`anchors`, `padLabels`) plus the scene's
`bbox`. `shiftSceneInPlace` (`renderBoard.ts`) applies that same offset
permanently instead of redrawing it every frame, and `commitBoard` takes a
new `inPlaceShift` option that calls it and returns before ever reaching
`buildBoardScene`.

Restricted to a whole-footprint selection, deliberately: `netLabels` and
`viaNetLabels` (a track or via's net-name text) carry no owner field, so a
moved track, arc or via still has no way to be patched here and falls back
to the ordinary rebuild. Widening that would mean giving those two arrays
an `owner` the way `anchors` and `padLabels` already have one: plausible
future work, not done now. Also restricted to a plain Move (`inPlaceMoveRef`
locally, `remoteInPlaceRef` for a peer): a rubber-banded Drag rebuilds the
connected tracks' geometry, which is not a pure translation, so it was
already excluded from the in-place GPU path entirely and is unaffected
either way. A commit that also needs a teardrop refresh is excluded too,
for the same reason: that pass can add or reshape geometry the shift never
touched.

Verified by mutation: five mutants (dropping the anchor's `y` shift,
removing the owner filter so an unrelated footprint's anchor moved too,
skipping a pad label's glyph-item shift, removing each of the three
eligibility guards in `commitMove`, `commitBoard` and the remote hand-off)
each fail exactly the test written to catch it, and typecheck green for
every one. `pnpm -C designer typecheck`, `biome check` on the touched files,
and the full `pcbnew`/`designer` unit suites all pass (one unrelated,
pre-existing Windows path failure in `footprint_io.test.ts`, spawned as its
own task rather than fixed here).

Not verified live in a two-tab session: this shortcut only changes how
cheaply the already-correct post-drop picture is reached, not what that
picture looks like, so a live pass would be confirming render correctness
this document's earlier `inPlaceShift` sections already confirmed, not this
change's own logic. Confidence rests on the mutation coverage above.

## The remote selection box lag was back, for the overlay-fallback path (2026-09-03)

Reported live, immediately after the fix above: grabbing an item with the
M key still showed the peer's dashed box at the wrong spot for a moment
after the drop, the same symptom "The remote selection box lagged behind
its own drop" was supposed to have closed. A live two-tab session with the
receiving tab instrumented (a patched `strokeRect` logging every draw of
the box) caught it directly: two draws about 240ms apart, the first at the
pre-drop position, the second at the correct one.

The earlier fix widened the exclusion to `remoteLiveMoveActiveRef.current
|| remoteInPlaceRef.current !== null`, reasoning that `remoteInPlaceRef`
stays non-null across the whole gap between `live-move-end` and the
debounced `board-patch` landing. True, but only for the in-place path.
When the receiver's GL cannot address the moved items (no WebGL2, a
lost or blocked context, a reference image on the board) the gesture
takes the overlay-fallback branch instead, and `remoteInPlaceRef` stays
null for that gesture from the very start, having never been set. Nothing
was watching that gap for this path, so it reopened exactly as before.

`moveSceneRef` is what the fallback's own overlay paints from, and it
stays non-null across precisely that window, cleared only once its own
deferred double-rAF commit lands (see "Bugs found and fixed so far" above
for that mechanism). Adding `moveSceneRef.current !== null` to the
exclusion closes the same gap for this path the way `remoteInPlaceRef`
closes it for the other one.

Whether an M key grab versus a mouse drag reliably decides which of the
two paths a given gesture takes was not established; both reach
`beginMove`/`commitMove` through identical code for the common case (a
single already-selected footprint), so if there is a deterministic link
it is elsewhere, upstream of this fix. What the instrumented session did
establish directly is that the overlay-fallback path's own settling
window had no protection at all, which is a real gap regardless of what
reliably triggers it.

Verified by mutation: reverting the exclusion to the previous two-term
condition fails the test written for the added term, typecheck green.
Not re-confirmed live after the fix (the same two-tab session that caught
the bug hit environment trouble immediately after: a stale viewport
mapping made clicks land off-canvas, and the instrumented tab's own
zoom made the box sub-pixel and invisible even when logged). Confidence
rests on the mutation coverage and the fact that the fix is a pure
widening of an existing, already-verified exclusion: it can only ever
hide the box for longer, never expose it somewhere new.

User's own live retest (2026-09-03): improved but not fully consistent,
the box still occasionally shows the lag. Whatever picks between the
in-place and overlay-fallback paths for a given gesture is not fully
understood (see above: both an M key grab and a mouse drag reach identical
code for the common case), so there may be a third path, or a narrower
race inside one of these two, still uncovered. Logged below rather than
chased further right now, since it is intermittent and cosmetic (a
selection indicator, not the board data).

## PeerRole: Owner, Editor, Viewer (2026-09-03)

Answers one of `multiplayer-architecture.md`'s open questions, "who is
allowed to do what," for PCB. The shape is Figma's: three roles, not two,
because "who gets to demote a Viewer back to Editor" needs an answer and
"whoever happens to click first" is not one.

**Owner** is not assigned by anyone. Each peer decides its own on
connect, by the rule that needs no coordination: the first one to find
nobody else already present, after a short window for someone else's
hello to arrive, names itself the owner. Everyone who joins after that
starts as **Editor**. The Owner is the only one who can move someone
else to **Viewer** and back, via a new `role-assign` message addressed
to that one peer (`toPeerId`, the same pattern `snapshot` already uses).

A Viewer gets full awareness: the same presence, the same live cursors
and selections, as an Editor. The only thing it cannot do is commit an
edit of its own. That is refused in exactly one place, `commitBoard`,
the same choke point undo and the local-edit tracking already go
through: `if (!applyingRemoteRef.current && myRoleRef.current ===
'viewer') return;`. `applyingRemoteRef` is what tells a Viewer's own
refused edit apart from someone else's edit arriving over the wire: a
Viewer must still watch the board change under people who can edit it.
`beginMove` carries the same check, so an interactive drag is refused
before it starts rather than following the cursor and silently snapping
back on drop; the other guarded commands (delete, rotate, group, and the
rest already gated for `isRemoteLocked`) rely on the `commitBoard` guard
alone; a single key press doing nothing reads fine without a second
guard the way a drag that un-does itself does not.

Identity rides along for free: `PresenceInfo` now carries a
`displayName`, the signed-in account's email when Supabase auth is
configured, falling back to the existing short peerId label otherwise.
This is `multiplayer-architecture.md` requirement 5, half answered: a
name, not yet an avatar or a distinct colour per peer.

A new `PresencePanel` opens from the existing presence badge (now a real
button instead of a hover-only tooltip): every connected peer, its name
and role, and (only if this tab is the Owner) a role select next to
each other Editor or Viewer. A Viewer sees a `ReadOnlyNotice` banner
above the canvas, the same component the demo-project read-only mode
already uses, explaining why nothing sticks.

**This is honor system, on purpose, for now.** Nothing here checks that
a `role-assign` sender is really the Owner, and nothing stops a modified
client from calling `commitBoard` directly regardless of its own
assigned role, the same trust level `beginMove`'s remote-lock check
already runs on. Real enforcement needs a server that can refuse a
write from someone who is not a collaborator on that project at all,
which today's schema cannot even represent (every table is keyed
`(user_id, project_id)`, single-owner, no sharing row of any kind). That
is deliberately a separate, later, backend-shaped decision: same
bucket as cross-device transport, and worth making together since
Supabase already backs auth and storage here.

Schematic gets the identity half only (`displayName` announced, same
fallback), no roles, no guard, no panel. Extending it is the same shape
of work, not new design.

Verified: 8 new unit tests over the transport (owner election, both ways
it can go; `role-assign` applied only when addressed to this peer;
`self-role` carrying an owner-election or an applied role-assign back to
the UI; display name in presence) plus text-assertion tests over the two
`commitBoard`/`beginMove` guards, the presence-panel wiring, and the
viewer notice: 8 mutants (one caught only after widening a
too-permissive assertion window that would have passed even with the
addressing check deleted, since the very next branch, `snapshot`, has
the identical check for its own field). `pnpm -C designer typecheck`,
`biome check` on the touched files, and the full unit suite all pass.

The first draft of `.ze-presence-panel` and `.ze-presence-role-select`
stated `font-size: 12px` directly, matching the pre-existing badge next
to them, and `ui_font_tokens.test.ts` caught it: that baseline only ever
goes down, two new sites is exactly the "gained a literal" case the file
exists to catch. Fixed by stating no font-size at all, the same as
`.ze-bgjob-list` right above it in the stylesheet: inheriting the
ambient size rather than restating it is the actual rule here, not
"restate the same value with a token," and the badge's own pre-existing
`12px` is unrelated debt, not a precedent to extend. Confirmed the fix
nets to zero against a pristine checkout of this branch (`git stash`
before/after): the count this branch already fails that check on with
zero of these changes applied is unrelated pre-existing drift, unchanged
by anything here.

Verified live, two tabs: the first tab correctly self-elects Owner, the
second joins as Editor; the panel shows both roles correctly, with the
role select appearing only on the Owner's side and only next to the
non-owner; setting the second tab to Viewer live-updates its own badge,
shows the notice, and an attempted drag on that tab does not move
anything at all (position unchanged, no console errors); setting it
back to Editor immediately re-enables editing, confirmed by a real
committed move.

## A distinct colour per peer (2026-09-03)

Answers requirement 5's other half: every remote cursor, selection box
and presence-row dot used the same single orange (`REMOTE_CURSOR_COLOR`)
regardless of who it belonged to, so "who is doing what" stopped being
answerable the moment a third person joined. `designer/src/sync/
peerColor.ts` hashes a peerId (FNV-1a, cheap and deterministic, not
collision-resistant, which this has no need to be) into an eight-colour
palette, `[0]` being the exact orange every peer used before this so the
common one-other-peer case has a real chance of looking unchanged. No
upstream KiCad table to cite: the built-in copper/gerbview layer-cycling
palettes exist for layer colours, a different job, and reusing them for
peer identity would be borrowing data for a purpose it was never chosen
for. Documented on the module itself as the same kind of literal
`REMOTE_CURSOR_COLOR` already was, since KiCad has no notion of another
viewer on its document at all.

Wired into every place that constant used to be: the PCB editor's remote
selection box and cursor (both the stroke and the label, so the two
never disagree about which peer they belong to), the schematic editor's
remote cursor, and the presence panel's per-row dot (including the
panel's own row for "you," from this tab's own peerId).

Verified: a real unit suite for the hash/palette itself (deterministic,
always a valid hex colour, the old orange still reachable, a realistic
peer count actually spreads across more than one colour) plus a real
`@testing-library/react` render test for the panel (each row's dot
matches `peerColor(peerId)` for that exact row, and two peers whose
colours are known in advance to differ render visibly different dots):
this component is small enough to mount directly, unlike the two big
editors. Six mutants across the palette, the hash, and every call site
in both editors, each caught by exactly the test written for it, one
only after a rewrite: the first version of the palette-content test used
20 random UUIDs and let an invalid palette entry through by chance
(never happened to hash to it), fixed by scanning a large deterministic
sequence instead so every palette entry is actually visited.

Caught two of its own literal-count violations against
`central_values.test.ts`, the project's running tally of hardcoded
colours and layout metrics that is only ever allowed to fall, never
rise. Unlike the font-size case above, there was no "state nothing
instead" fix available here: eight peer colours and a new popup's
spacing are genuine data with no shared token to point at instead, so
the honest fix was updating the baseline with the same kind of narrated
comment the file already uses everywhere else, not making the literals
disappear. Both totals were already stale by a few sites on a pristine
checkout before this change touched anything (confirmed via `git
stash`); that drift is called out inline as pre-existing and left alone
rather than folded silently into this change's own, clearly-labelled
delta.

`pnpm -C designer typecheck`, `biome check` on the touched files, and
the full relevant unit suite all pass (`central_values.test.ts` itself
still has its own unrelated, pre-existing per-area failures from the
Windows path-separator bug already flagged as a separate task).

## PeerRole reaches the schematic editor (2026-09-03)

Closes the gap "PeerRole: Owner, Editor, Viewer" left open above:
schematic had the identity half only (`displayName` in presence), no
roles, no guard, no panel. Same shape of work as PCB, not a new design,
so this section is short.

Schematic has no single `commitBoard` choke point the way PCB does.
`runCommand` is the one every edit to the *currently open* sheet runs
through, and gets the same guard PCB's `commitBoard` has: `if
(!applyingRemoteRef.current && myRoleRef.current === 'viewer')
return;`. But four separate call sites edit a sheet other than the open
one by bypassing `runCommand` entirely and going straight at that
sheet's own undo history: `applySheetCommand` (Sync Sheet Pins and
friends), `applySheetSymbols` (Increment Annotations), `applySheetDocument`
(whole-document replacement, the same primitive the remote-update path
below rides), and `applyFieldsEdits`'s other-file branch (Bulk Edit
Symbol Fields). Guarding only `runCommand` would have left a Viewer
free to annotate or bulk-edit a sheet they merely weren't looking at,
so each of the four other-file branches carries its own copy of the
same guard rather than inheriting one for free. `applyingRemoteRef` is
set around the one remote-update call site (into `applySheetDocument`)
so a peer's own change still lands on a Viewer's tab; unlike PCB's copy
of this ref, which persists across a render because a cross-render gap
separates its set from its reset, schematic's is set and reset
synchronously around the single call, since nothing here needs that gap
bridged.

No `beginMove`-equivalent gesture-start guard: a schematic move isn't
funnelled through one function the way a PCB drag is (`SchematicCanvas.tsx`
sets `modeRef` directly at several scattered call sites), so a Viewer
can still visually start dragging a symbol; it just will not commit on
drop, refused by the `runCommand` guard the drop itself runs through.
Same "reads fine without the extra polish" tradeoff PCB's own
non-drag guarded commands already accept, not a new gap this change
introduces.

Everything else mirrors PCB exactly: `transport.connect` now announces
`displayName`; `self-role` and `role-assign` are handled the same way;
`myRoleRef` mirrors `myRole` every render; the presence badge is now a
real button opening a `PresencePanel` with the same `onSetRole`
publishing a `role-assign`; a Viewer sees the same `ReadOnlyNotice`
above the canvas.

Verified: 13 text-assertion tests over `SchematicEditor.tsx` (too large
to mount, same technique `pcb_peer_roles.test.ts` uses for
`PcbEditor.tsx`) covering all five guarded call sites, the
`applyingRemoteRef` bracket, the transport wiring, and the panel/notice
JSX. 11 mutants, one per guarded site plus the connect/panel/notice/button
wiring, each caught by exactly the test written for it. `pnpm -C
designer typecheck`, `biome check` on the touched file, and the full
relevant unit suite (including the existing PCB and peer-colour suites,
re-run to confirm nothing regressed) all pass.

## Outstanding

- ~~Grab/selection locking between clients~~: done, see "Grab/selection
  locking" above, including a same-item grab actually being refused live
  from a second tab (confirmed via the M shortcut plus a control test, not
  just unit tests). Router-drag coverage remains out of scope, consistent
  with router drags having no live sync at all.
- ~~The drop costs a full rebuild on every peer, for a plain Move~~: done for
  the common case, see "A plain Move skips the rebuild it does not need"
  above. What is left is genuinely harder and narrower: a moved track, arc
  or via (no owner on its net-name label to patch), a rubber-banded Drag (not
  a pure translation), and anything that also changes shape or orientation
  (a rotate, a resize) rather than only position. Each of those still pays
  the full rebuild, same as before.
- **Cross-device transport.** Everything above runs over `BroadcastChannel`
  (same browser, cross-tab only). The actual online transport (Supabase
  Realtime or equivalent) is unbuilt; `ProjectSyncTransport` exists as the
  seam so the editor code doesn't know which transport it's talking to.
- ~~Who is allowed to do what~~: done for both editors, see "PeerRole:
  Owner, Editor, Viewer" and "PeerRole reaches the schematic editor"
  above. What is left is real server-side enforcement: today this is an
  honor system, same trust level as locking, and needs both the
  transport above and a project-sharing model the current single-owner
  database schema cannot represent at all yet.
- **Small, known issue:** the remote selection box's lag after a drop is
  fixed for the two paths this document has identified (in-place and
  overlay-fallback) but still shows up occasionally: see "The remote
  selection box lag was back, for the overlay-fallback path" above.
  Low priority: cosmetic (a selection indicator, not board data) and
  intermittent, not reproduced on demand. Revisit if it gets worse or a
  reliable repro turns up.
