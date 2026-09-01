# PCB live multiplayer sync

**Status: in progress.** Started 2026-08-31. First slice (diff-based document
sync + live drag preview) built and partially verified; selection/grab locking
not started.

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
(see Outstanding — a commit that knows what it touched is what incremental
scene patching needs), but it would not make command *replay* safe over the
wire: the router's push-and-shove and zone fill are floating-point geometry
with no guarantee that "the same operation" replayed on a receiver's board
reproduces byte-identical results, and silently diverging two peers' boards is
worse than being slow. Diffing the result stays the right call regardless.

## The approach: diff the result, not the operation

Every PCB item type carries its own `uuid` and its own `source` SList
(lossless round-tripping is already a hard requirement here for file
fidelity), so an item is a self-contained, uuid-keyed unit — safe to diff and
safe to splice into a *different* board wholesale. `designer/src/sync/pcb_diff.ts`:

- `diffCollection` / `diffBoard` — uuid-keyed diff between two `Board`s.
  Returns `undefined` for "no change" and a distinct `UNSAFE` sentinel when
  some item lacks a uuid, so the two cases are never conflated (an earlier
  draft of this collapsed them into one `null` and broke almost every edit).
- `applyBoardPatch` — splices a patch into a receiver's own board object by
  uuid, correctly even when sender and receiver boards are different
  references (confirmed against a real fixture: patch computed against one
  loaded copy, applied to a separately-loaded copy of the same file, lands
  correctly).
- Falls back to whole-board text sync (`model-changed`, via a Web Worker —
  `pcb_sync_pool.ts` / `pcb_sync_worker.ts` — since serialize/parse measured
  ~80-160ms synchronous on a real 7.6MB board) only when a touched
  collection is `UNSAFE`.

Measured on a real board: a one-footprint move produces a ~71KB patch against
a 7.6MB board (107x smaller), not touching any unrelated collection.

## Live drag preview

A move/drag gesture broadcasts its own uncommitted state before the 400ms
debounced `board-patch` lands, so peers see the drag happen rather than
snapping at the end:

- `live-move-start` — one-time snapshot of the dragged items, at drag start.
- `live-move-delta` — cheap, throttled (~80ms) position updates while the
  gesture continues.
- `live-move-end` — clears the preview; only sent for a zero-delta/cancelled
  gesture, since a real move's own `board-patch` replaces the preview
  cleanly when it lands.

Reused the existing `moveSceneRef`/`moveDeltaRef` overlay mechanism (a small
scene drawn on top of the base scene, translated by a delta at draw time)
that local drags already use — `draw()` needed no changes, since its
composite logic was already generic to "whose delta is this."

Router drags (push-and-shove) are explicitly out of scope for live preview —
that gesture rebuilds stretched geometry every frame even locally.

## Bugs found and fixed so far

- **`diffCollection` conflating "no change" and "unsafe"** — caught before
  any live test ran.
- **Ghost item + full-board flicker on every drag** — the live-move overlay
  was drawn on top of a base scene that still had the original item in it.
  Fixed by pulling the dragged items out of the base scene once at
  `live-move-start` (`boardMinusUuids`), mirroring what local track-drag
  already does.
- **`emptyBoardLike` / `subsetBoardItems` never filtered `dimensions` or
  `images`** — a genuine pre-existing bug in Ziro's own PCB engine, not
  introduced by this work, found while chasing "dragging a footprint drags
  all dimensions." Confirmed via a third, correct sibling
  (`emptyClipboardBoard` in `pcb_clipboard.ts`) that did include both
  fields. Fixed both functions; regression-tested via `git stash` (2 of 3
  new tests failed against the pre-fix code, confirming they actually catch
  it).
- **Ghost item on *any* remote edit, not just drags** — the fix above only
  covered the four collections a plain drag touches. The general
  `board-patch` apply path (any committed remote edit — rotate, delete,
  nudge, not just drag) never removed the patch's *prior* items from the
  base scene before drawing the new-position overlay, so every non-drag
  remote edit ghosted a stale duplicate until the full scene rebuild caught
  up ~200ms+ later. Fixed with `boardMinusPatch`, the general form of
  `boardMinusUuids` covering all twelve item collections a `BoardPatch` can
  touch.
- **The receiver was on the slow drag path all along** — the real cause of
  both reported symptoms, found only after the two attempts below failed to
  change what the user saw. A local drag is smooth because of
  `beginMove`'s in-place branch: `PcbGl.moveItems` shifts the dragged items'
  vertices inside the retained buffer (`Scene.itemRanges`), so nothing is
  recompiled, nothing is re-recorded, and there is no second copy anywhere.
  The remote path never had that branch. It always took the *fallback* —
  compile a base scene with the items removed, compile an overlay, offset
  the overlay per frame — and `buildBoardScene` costs a full board compile
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
  `requestDraw()` of the gesture — and `buildBoardScene` over "the whole
  board minus a few items" costs the same as compiling the whole board
  (the ~220ms figure above). `live-move-start` paid that once per drag,
  at the start; the `board-patch` apply path paid it a *second* time on
  top of `commitBoard`'s own rebuild at the end, since the two are
  computing near-identical scenes. Net effect: every remote drag froze
  the receiving tab twice, for the same ~220ms each time, with a paint in
  between — which reads as flicker, not as a hang. Fixed by reordering
  both sites to match `startOverlayMove`/`scheduleBaseWithout`'s existing
  split for a *local* drag: show the cheap overlay first
  (`requestDraw()`), then defer the expensive exclusion with
  `setTimeout(fn, 0)` rather than running it inline. `baseRebuildRef`'s
  generation token (already used by `scheduleBaseWithout`) makes the
  deferred call a no-op if a newer drag, or `commitBoard`'s own
  `rebuildScene`, lands first — `rebuildScene` bumps the same counter as
  its first line, so the ordering race resolves safely either way. This
  does not eliminate the `board-patch` path's two full rebuilds (that
  needs incremental scene patching — see Outstanding), only the part
  where the first one blocked the first paint.

## What's verified versus what needs a live check

Verified directly: unit tests for the diff/patch logic against a real board
fixture, the worker round-trip, and the `subsetBoardItems`/`emptyBoardLike`
regressions (git-stash-proven). Typecheck, biome, and the full designer build
are clean after each change.

Measured on the receiving tab during a real two-tab drag of a footprint
(coldfire demo, `PerformanceObserver` on `longtask`): **zero long tasks for
the whole duration of the drag**, with the only heavy work — 266ms + 118ms +
57ms — arriving after the drop, which is `commitBoard`'s own `rebuildScene`
plus the GPU re-record that follows it. Before this change the same probe
would have had to show a ~220ms stall at drag *start* as well, since
`live-move-start` called `buildBoardScene` synchronously.

**Not verified**: the A/B for that claim. The intended counterfactual (force
`inPlace` false, re-run, watch the mid-drag stall appear) never ran — the
synthetic pointer-down missed the footprint and rubber-band-selected instead,
so the mutant run proves nothing and was discarded rather than reported as a
pass. The null result above therefore rests on one direction only. Driving
these drags through synthetic `PointerEvent`s is unreliable at fit-zoom (a
100-pin LQFP is ~14px), and a screenshot cannot catch a sub-100ms transient,
so **the ghost being gone still needs a human eyeball.**

## Outstanding

- **Grab/selection locking between clients.** If one client grabs or selects
  an item, it should lock from everyone else until released. Not scoped or
  started — the diff-based sync above works whether or not this exists, so
  it was deliberately deferred rather than blocking the sync work on it.
- **The drop still costs a full rebuild on every peer** — measured at 266ms
  + 118ms above, and this board is 7.6MB-class boards' little sibling. After
  an in-place remote drag the GPU buffer is *already* showing the committed
  picture, and then `commitBoard` throws it away and recompiles the entire
  board to arrive back at it. Skipping the rebuild is not simply allowed,
  though: the scene carries screen-space data that `moveItems` does not
  touch (`anchors`, `padLabels`, `netLabels`, `bbox`), which is exactly why
  `inPlaceShift` has to offset them at draw time — drop the rebuild and
  those snap back to the pre-drag position. Doing this properly means
  incremental scene patching: teaching `BoardScene` to re-emit one item's
  geometry and its screen-space entries rather than recompiling every layer.
  That is the next real piece of work, and it would speed up local edits too.
  Not started.
- **Cross-device transport.** Everything above runs over `BroadcastChannel`
  (same browser, cross-tab only). The actual online transport (Supabase
  Realtime or equivalent) is unbuilt; `ProjectSyncTransport` exists as the
  seam so the editor code doesn't know which transport it's talking to.
