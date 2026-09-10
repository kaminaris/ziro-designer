// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
// Portions derived from KiCad, copyright The KiCad Developers. See NOTICE.md.
/**
 * A footprint being dragged leaves nothing behind at the place it started.
 *
 * Upstream this cannot go wrong, because there is only one mechanism:
 * `VIEW::Update` re-caches the item that moved and everything it draws goes
 * with it, anchor cross included. We have two — a GPU path that translates the
 * item's recorded vertices in place, and an overlay path that takes the item
 * out of the board and draws a copy at the cursor — and each of them had a way
 * to leave the original sitting where it was.
 *
 * The LAYER_ANCHOR cross is the one this file can measure directly. It is
 * screen-space (`draw(FOOTPRINT)`: "size and width constant, not related to the
 * scale because the anchor is just a marker on screen"), so it is a per-frame
 * pass and can never be part of the buffer the GPU drag translates. Nothing
 * told it about the drag, so a moved footprint left its magenta cross —
 * `LAYER_ANCHOR` is rgb(255, 38, 226) — at the position it started from until
 * the drop, at which point the whole scene was rebuilt and it jumped across.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@ziroeda/sexpr/src/index.js';
import { readBoard } from '@ziroeda/pcbnew/src/read-board.js';
import {
  buildScene,
  drawAnchors,
  drawNetNames,
  shiftSceneInPlace,
  DEFAULT_DRAW_OPTIONS,
} from '@ziroeda/designer/src/editors/pcb/renderBoard.js';
import { GL_PATH_FACTORY } from '@ziroeda/designer/src/render/gl/gl_path.js';

const MM = 1e6;

/**
 * PcbEditor.tsx as text. The wiring that decides whether these passes are ever
 * told about a drag lives in a .tsx, which qa's tsconfig cannot compile, so it
 * is read the way view_controls_coverage.test.ts reads its call sites.
 */
const text = readFileSync(
  fileURLToPath(new URL('../../../designer/src/editors/pcb/PcbEditor.tsx', import.meta.url)),
  'utf8',
);

const board = () =>
  readBoard(
    parse(`(kicad_pcb (version 20241229) (generator "test")
  (footprint "R" (layer "F.Cu") (at 100 100))
  (footprint "C" (layer "F.Cu") (at 140 100))
)`),
  );

/** Records where each cross arm was drawn, in device pixels. */
const recordingCtx = (): { ctx: CanvasRenderingContext2D; xs: () => number[] } => {
  const xs: number[] = [];
  const ctx = {
    setTransform: () => {},
    beginPath: () => {},
    moveTo: (x: number) => {
      xs.push(x);
    },
    lineTo: () => {},
    stroke: () => {},
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, xs: () => xs };
};

const scene = buildScene(board(), {}, GL_PATH_FACTORY);
/** Past MINIMAL_ZOOM_FOR_ANCHORS (1.5), or the pass draws nothing at all. */
const view = { scale: (2.05 * 91) / 25.4 / MM, tx: 0, ty: 0 };
const front = new Set(['F.Cu']);

/**
 * The distinct x positions the crosses were centred on.
 *
 * Each cross is a horizontal arm (`moveTo( x - arm )`) then a vertical one
 * (`moveTo( x )`), so the larger of each pair is the centre. The values carry
 * a half pixel because `snapPx` centres a 1 px pen on the pixel grid.
 */
const centres = (shift: { ids: ReadonlySet<string>; dx: number; dy: number } | null): number[] => {
  const rec = recordingCtx();
  drawAnchors(rec.ctx, scene, view, front, 4000, 4000, undefined, 'none', 1, shift);
  const xs = [...new Set(rec.xs())].sort((a, b) => a - b);
  // Drop the arm starts: they sit exactly `arm` (5 px) left of a centre.
  return xs.filter((x) => xs.some((o) => Math.abs(o - (x - 5)) < 1e-6));
};

/** Is a cross centred within half a pixel of `mm`? `snapPx` moves it that far. */
const hasCrossAt = (at: number[], mm: number): boolean =>
  at.some((x) => Math.abs(x - mm * MM * view.scale) <= 0.5);

describe('the anchor cross belongs to its footprint', () => {
  it('records the owning board-item id with each anchor', () => {
    expect(scene.anchors.map((a) => a.owner)).toEqual(['footprint:0', 'footprint:1']);
  });

  it('draws both crosses where the footprints are when nothing is moving', () => {
    const at = centres(null);
    expect(at).toHaveLength(2);
    expect(hasCrossAt(at, 100)).toBe(true);
    expect(hasCrossAt(at, 140)).toBe(true);
  });
});

describe('an in-place GPU drag takes the anchor with it', () => {
  it('shifts only the moving footprint', () => {
    const still = centres(null);
    const moved = centres({ ids: new Set(['footprint:0']), dx: 20 * MM, dy: 0 });

    // R was at 100 mm and is being dragged 20 mm right: its cross is at 120.
    expect(hasCrossAt(moved, 120)).toBe(true);
    expect(hasCrossAt(moved, 100)).toBe(false);
    // C is not in the drag, so it has not moved.
    expect(hasCrossAt(moved, 140)).toBe(true);
    expect(hasCrossAt(still, 100)).toBe(true);
  });

  it('moves every footprint of a multi-item drag', () => {
    const moved = centres({
      ids: new Set(['footprint:0', 'footprint:1']),
      dx: -10 * MM,
      dy: 0,
    });
    expect(hasCrossAt(moved, 90)).toBe(true);
    expect(hasCrossAt(moved, 130)).toBe(true);
  });

  it('a zero delta is indistinguishable from no drag', () => {
    expect(centres({ ids: new Set(['footprint:0']), dx: 0, dy: 0 })).toEqual(centres(null));
  });

  it('ignores ids that are not footprints', () => {
    expect(centres({ ids: new Set(['track:3']), dx: 25 * MM, dy: 0 })).toEqual(centres(null));
  });
});

describe('the overlay fallback is wired for a drag that started in place', () => {
  // The other half, which only the source can show: `updateMove`'s in-place
  // branch used to clear `inPlaceMoveRef` when `gl.moveItems` refused and do
  // nothing else. The gesture then had no overlay (beginMove's in-place branch
  // returns before building one) AND the originals still in the retained scene
  // (it returns before scheduling the rebuild too), so the part sat still while
  // the selection copy followed the cursor.
  it('both entries into the slow path call the one function', () => {
    // Declared once...
    expect(text).toContain('const startOverlayMove = (');
    // ...and called from exactly two places: beginMove, and the moveItems
    // failure. Two is the point of the test: before this there was one.
    expect(text.match(/startOverlayMove\(/g)).toHaveLength(2);
  });

  it('the failure branch does more than clear the flag', () => {
    const i = text.indexOf(
      'The GPU could not take it after all; fall back for the rest of the drag.',
    );
    expect(i).toBeGreaterThan(-1);
    const after = text.slice(i, i + 700);
    expect(after).toContain('inPlaceMoveRef.current = null;');
    expect(after).toContain('startOverlayMove(');
  });

  it('the frame builds the shift from the delta the GPU applied', () => {
    // The unit tests above exercise the passes; this is the wiring that decides
    // whether they are ever told anything.
    const i = text.indexOf('const localShift = inPlaceMoveRef.current');
    expect(i).toBeGreaterThan(-1);
    const decl = text.slice(i, i + 320);
    expect(decl).toContain('ids: dragAffectedRef.current');
    expect(decl).toContain('dx: localShift.x');
    expect(decl).toContain('dy: localShift.y');
    // `inPlaceMoveRef`, not `moveDeltaRef`: the buffer may be a frame behind
    // the cursor, and the passes must agree with the buffer, not the pointer.
    expect(decl).not.toContain('moveDeltaRef');
  });
});

describe('a remote drag draws with the current render closure', () => {
  it('the long-lived sync subscription never calls its captured requestDraw', () => {
    // Now MORE load-bearing than when this was written, not less: the
    // subscription used to be re-created whenever the project name or the
    // display name changed, and since ProjectSyncProvider took ownership of
    // the connection it only re-runs when the transport itself does. A
    // `requestDraw()` captured in that closure would therefore go stale and
    // stay stale, painting a remote drag with a render closure from whenever
    // the tab connected.
    const start = text.indexOf('const transport = sharedSync;');
    const end = text.indexOf('}, [sharedSync]);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const subscription = text.slice(start, end);
    expect(subscription).toContain('requestDrawRef.current();');
    expect(subscription).not.toMatch(/(?<!Ref\.current)requestDraw\(\);/);
  });

  it('mouse-up sends the exact final delta before committing the board', () => {
    const comment = text.indexOf('The pointer stream is throttled');
    const commit = text.indexOf('commitBoard(', comment);
    expect(comment).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(comment);
    const release = text.slice(comment, commit);
    expect(release).toContain("publish({ kind: 'live-move-delta', x: delta!.x, y: delta!.y })");
  });

  it('does not repaint a receiver-local selection at the stale position', () => {
    expect(text).toContain('const remoteSelectionConflict =');
    expect(text).toContain(
      'const os = moveSceneRef.current ?? (remoteSelectionConflict ? null : selSceneRef.current);',
    );
    expect(text).toContain(
      'handles.length > 0 && !moveDeltaRef.current && !remoteSelectionConflict',
    );
  });
});

describe('pad numbers and net names travel too', () => {
  // The other per-frame pass, and the one in Akshay's capture: J1 moved and
  // left its pad numbers "1" and "2" behind. Same debt as the anchors — text
  // laid out once in world coordinates and drawn every frame, so the buffer
  // the GPU translated never touches it.
  //
  // The `(layers …)` block is load-bearing: `expandLayers` resolves a pad's
  // `*.Cu` against the board's copper names, and without it every label comes
  // out with an empty layer list and PAD::ViewGetLOD's "hide netnames unless
  // the pad is flashed to a visible layer" drops the lot.
  const padBoard = () =>
    readBoard(
      parse(`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (footprint "J" (layer "F.Cu") (at 100 100)
    (pad "1" thru_hole circle (at -2.5 0) (size 2 2) (drill 1) (layers "*.Cu"))
    (pad "2" thru_hole circle (at 2.5 0) (size 2 2) (drill 1) (layers "*.Cu"))
  )
)`),
    );

  const padScene = buildScene(padBoard(), {}, GL_PATH_FACTORY);
  /** 20 px per mm keeps the footprint at 100 mm inside a 4000 px viewport. */
  const padView = { scale: 20 / MM, tx: 0, ty: 0 };

  it('records the owning footprint with each pad label', () => {
    expect(padScene.padLabels).toHaveLength(2);
    expect(padScene.padLabels.every((l) => l.owner === 'footprint:0')).toBe(true);
  });

  /**
   * Where the pad text was placed, in world units.
   *
   * The target carries a `bitmapText` method, which is how `drawNetNames`
   * decides it is drawing to the atlas — that is the path the GPU frame takes,
   * and the one whose anchors are worth measuring.
   */
  const textAt = (
    shift: { ids: ReadonlySet<string>; dx: number; dy: number } | null,
  ): { x: number; y: number }[] => {
    const at: { x: number; y: number }[] = [];
    const ctx = {
      setTransform: () => {},
      bitmapText: (_t: string, p: { x: number; y: number }) => {
        at.push({ x: p.x, y: p.y });
      },
      strokeStyle: '',
    } as unknown as CanvasRenderingContext2D;
    drawNetNames(
      ctx,
      padScene,
      padView,
      new Set(['F.Cu']),
      4000,
      4000,
      DEFAULT_DRAW_OPTIONS,
      'none',
      1,
      'over',
      shift,
    );
    return at;
  };

  it('places the text on the pads when nothing is moving', () => {
    const at = textAt(null);
    expect(at).toHaveLength(2);
    // Pads at 100 mm ± 2.5 mm.
    expect(at.map((p) => p.x).sort((a, b) => a - b)).toEqual([97.5 * MM, 102.5 * MM]);
  });

  it('shifts the text by the delta the GPU applied', () => {
    const moved = textAt({ ids: new Set(['footprint:0']), dx: 20 * MM, dy: -7 * MM });
    expect(moved.map((p) => p.x).sort((a, b) => a - b)).toEqual([117.5 * MM, 122.5 * MM]);
    expect(moved.every((p) => p.y === 93 * MM)).toBe(true);
  });

  it('leaves the text of a footprint that is not in the drag alone', () => {
    expect(textAt({ ids: new Set(['footprint:9']), dx: 20 * MM, dy: 0 })).toEqual(textAt(null));
  });

  it('all three drawNetNames call sites are handed the shift', () => {
    // Two GPU passes (under and over) and the Canvas2D fallback.
    expect(text.match(/^\s*inPlaceShift,$/gm)).toHaveLength(4); // + drawAnchors
  });
});

describe('shiftSceneInPlace folds a completed move into the scene for good', () => {
  // The permanent counterpart to the per-frame `shift` above: once a plain
  // Move commits, `anchors` and `padLabels` have to actually move rather than
  // being nudged back to nothing next frame — otherwise the very first frame
  // after the drop (before some *other* edit finally forces a full rebuild)
  // shows the cross and the pad text back at the pre-drag position.
  //
  // Same fixture shape as "pad numbers and net names travel too" above (a
  // footprint with two pads at ±2.5 mm), redefined here since that one scopes
  // its own `padBoard` to its own describe block.
  const padBoard = () =>
    readBoard(
      parse(`(kicad_pcb (version 20241229) (generator "test")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (net 0 "")
  (footprint "J" (layer "F.Cu") (at 100 100)
    (pad "1" thru_hole circle (at -2.5 0) (size 2 2) (drill 1) (layers "*.Cu"))
    (pad "2" thru_hole circle (at 2.5 0) (size 2 2) (drill 1) (layers "*.Cu"))
  )
)`),
    );

  it('shifts the anchor and pad label of the moved footprint, permanently', () => {
    const s = buildScene(padBoard(), {}, GL_PATH_FACTORY);
    const anchorBefore = { x: s.anchors[0]!.x, y: s.anchors[0]!.y };
    const itemsBefore = s.padLabels.map((l) => l.items.map((it) => ({ x: it.at.x, y: it.at.y })));
    shiftSceneInPlace(s, new Set(['footprint:0']), 20 * MM, -7 * MM);
    expect(s.anchors[0]!.x).toBe(anchorBefore.x + 20 * MM);
    expect(s.anchors[0]!.y).toBe(anchorBefore.y - 7 * MM);
    // Pads at 100 mm ± 2.5 mm, per the fixture in the describe block above.
    const afterXs = s.padLabels.map((l) => l.at.x).sort((a, b) => a - b);
    expect(afterXs).toEqual([117.5 * MM, 122.5 * MM]);
    // Every glyph run inside every pad label moved by the same delta too.
    s.padLabels.forEach((label, li) => {
      label.items.forEach((item, ii) => {
        expect(item.at.x).toBe(itemsBefore[li]![ii]!.x + 20 * MM);
        expect(item.at.y).toBe(itemsBefore[li]![ii]!.y - 7 * MM);
      });
    });
  });

  it('leaves a footprint outside the moved set untouched', () => {
    const s = buildScene(board(), {}, GL_PATH_FACTORY); // two footprints
    const other = { ...s.anchors[1]! };
    shiftSceneInPlace(s, new Set(['footprint:0']), 20 * MM, -7 * MM);
    expect(s.anchors[1]).toEqual(other);
  });

  it('a zero delta is a no-op', () => {
    const s = buildScene(padBoard(), {}, GL_PATH_FACTORY);
    const before = JSON.parse(JSON.stringify(s.anchors));
    shiftSceneInPlace(s, new Set(['footprint:0']), 0, 0);
    expect(s.anchors).toEqual(before);
  });

  it('an empty id set is a no-op', () => {
    const s = buildScene(padBoard(), {}, GL_PATH_FACTORY);
    const before = JSON.parse(JSON.stringify(s.anchors));
    shiftSceneInPlace(s, new Set(), 20 * MM, 20 * MM);
    expect(s.anchors).toEqual(before);
  });
});

describe('a plain Move skips the full rebuild when it can', () => {
  // `commitBoard`'s `inPlaceShift` opt exists so a completed drag whose GPU
  // buffer already shows the drop position does not pay for `buildBoardScene`
  // a second time just to arrive back at the same picture (see
  // docs/proposals/pcb-multiplayer-sync.md, "The drop still costs a full
  // rebuild on every peer").
  it('commitBoard patches the scene in place instead of rebuilding when eligible', () => {
    const i = text.indexOf('const commitBoard = useCallback(');
    const body = text.slice(i, i + 1600);
    expect(body).toContain('if (opts.inPlaceShift && !refresh && sceneRef.current) {');
    expect(body).toContain('shiftSceneInPlace(sceneRef.current, ids, dx, dy);');
    // Teardrops can add or reshape geometry `moveItems` never touched, so a
    // commit that needs a teardrop refresh must not take the shortcut.
    const guardIdx = body.indexOf('if (opts.inPlaceShift && !refresh');
    const refreshIdx = body.indexOf('const refresh =');
    expect(refreshIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(refreshIdx);
  });

  it('commitMove only claims the shortcut for a whole-footprint plain Move', () => {
    const i = text.indexOf('const commitMove = (): void => {');
    const body = text.slice(i, text.indexOf('const cancelMove', i));
    expect(body).toContain(
      "wasInPlace && kind !== 'drag' && [...sel].every((id) => id.startsWith('footprint:'))",
    );
    expect(body).toContain('inPlaceShift: { ids: sel, dx: delta!.x, dy: delta!.y }');
  });

  it('the remote in-place hand-off takes the same shortcut, keyed off the accumulated delta', () => {
    const i = text.indexOf('if (remoteInPlaceRef.current) {');
    const body = text.slice(i, i + 900);
    expect(body).toContain(
      "shiftIds.size > 0 && [...shiftIds].every((id) => id.startsWith('footprint:'))",
    );
    expect(body).toContain('inPlaceShift: { ids: shiftIds, dx: shift.x, dy: shift.y }');
  });
});

describe('a local grab is refused if it collides with a live remote drag', () => {
  // `remoteAffectedRef` is set once in the sync subscription and read once in
  // `beginMove`; both have to see the same set; a fix that widens one and not
  // the other locks nothing it did not already lock.
  const startIdx = text.indexOf("payload.kind === 'live-move-start'");
  const startBlockEnd = text.indexOf("payload.kind === 'live-move-delta'", startIdx);
  const startBlock = text.slice(startIdx, startBlockEnd);

  it('names the set for both the in-place and overlay-fallback branches', () => {
    // Not `if (inPlace) { remoteAffectedRef.current = affected; ... }` — that
    // version left the fallback branch's ids unset, so a peer's drag using
    // the CPU path (no WebGL2, or a board with a reference image) could not
    // be locked against. Assert it is set before the branch, not inside it.
    const inPlaceIdx = startBlock.indexOf('const inPlace =');
    const setIdx = startBlock.indexOf('remoteAffectedRef.current = affected;');
    expect(inPlaceIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(inPlaceIdx);
  });

  const beginMoveIdx = text.indexOf('const beginMove = (');
  const beginMoveBody = text.slice(beginMoveIdx, beginMoveIdx + 2200);
  const promoteIdx = beginMoveBody.indexOf('promotePadsForCommand(brd, sel0)');
  const refuseIdx = beginMoveBody.indexOf('if (isRemoteLocked(brd, sel)) return;');
  const movingSelIdx = beginMoveBody.indexOf('movingSelRef.current = sel;');

  it('checks isRemoteLocked before touching movingSelRef', () => {
    // Order matters: the guard has to run, and return, before any state for
    // the (refused) gesture is written — a guard placed after
    // `movingSelRef.current = sel` would already have started committing to
    // the move by the time it decided to refuse it.
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(movingSelIdx).toBeGreaterThan(-1);
    expect(refuseIdx).toBeLessThan(movingSelIdx);
  });

  it('checks the post-promotion selection, not the raw grab', () => {
    // `sel`, from `promotePadsForCommand(brd, sel0)` — a grabbed pad has to
    // be checked as the footprint it promotes to, the same id a peer's
    // `live-move-start` would have named, or a pad-vs-footprint grab on the
    // same part would slip past the guard.
    expect(promoteIdx).toBeGreaterThan(-1);
    expect(promoteIdx).toBeLessThan(refuseIdx);
  });

  it('refuses the whole gesture, not just the colliding items', () => {
    // A partial grab that silently dropped the locked members would move a
    // different selection than the one the user grabbed — worse than
    // refusing outright. `isRemoteLocked` is a boolean; `beginMove` acts on
    // it with a bare `return`, never a per-id filter of `sel`.
    expect(beginMoveBody).toContain('if (isRemoteLocked(brd, sel)) return;');
  });
});

describe('remoteLockedIds / isRemoteLocked is the one place the lock rule lives', () => {
  const defIdx = text.indexOf('const remoteLockedIds = (brd: Board)');
  const isLockedIdx = text.indexOf('const isRemoteLocked = (brd: Board', defIdx);
  const defBlock = text.slice(defIdx, isLockedIdx);

  it('locks on an active drag AND a peer selection, not just the drag', () => {
    // The original ask was "grab OR select"; a version that only ever
    // consulted `remoteAffectedRef` would silently drop the "select" half.
    expect(defIdx).toBeGreaterThan(-1);
    expect(defBlock).toContain('remoteLiveMoveActiveRef.current ? remoteAffectedRef.current');
    expect(defBlock).toContain('remoteSelectionsRef.current.values()');
    expect(defBlock).toContain('boardIdsForUuids(brd, peerSel)');
  });

  // Every whole-selection command that transforms or removes items outright
  // has to consult this, not just `beginMove` — a peer's claim on an item is
  // exactly as real when it is rotated, mirrored, flipped, deleted, grouped
  // or locked out from under them as when it is dragged out from under them.
  const guarded = [
    'const deleteSel = useCallback(',
    'const rotateSel = useCallback(',
    'const mirrorSel = useCallback(',
    'const groupSel = useCallback(',
    'const ungroupSel = useCallback(',
    'const addToGroupSel = useCallback(',
    'const removeFromGroupSel = useCallback(',
    'const lockSel = useCallback(',
    'const flipSelection = useCallback(',
  ];

  it.each(guarded)('%s calls isRemoteLocked before committing', (marker) => {
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const commitIdx = text.indexOf('commitBoard(', start);
    expect(commitIdx).toBeGreaterThan(start);
    const body = text.slice(start, commitIdx);
    expect(body).toContain('isRemoteLocked(brd,');
  });

  it('duplicateSel deliberately does not guard — it never touches the original', () => {
    // Duplicating reads the item and creates a new one with a fresh uuid;
    // the locked item itself is never mutated, so there is nothing here for
    // the lock to protect. Documented so a future pass doesn't "fix" this
    // as a missed case.
    const start = text.indexOf('const duplicateSel = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const commitIdx = text.indexOf('commitBoard(', start);
    const body = text.slice(start, commitIdx);
    expect(body).not.toContain('isRemoteLocked');
  });
});

describe('a peer selection resolves and clears the way a drag does', () => {
  it('broadcasts by uuid, not by this tab (kind:index) ids', () => {
    // `boardItemUuids`, not raw `selection` refs — a peer's board can have
    // the same item at a different index, so sending `selection` directly
    // would lock (or highlight) whatever happens to sit at that index on
    // THEIR board, not the item the user actually selected.
    const i = text.indexOf("kind: 'selection', refs: boardItemUuids(brd, selection)");
    expect(i).toBeGreaterThan(-1);
  });

  it('prunes a departed peer selection on the next presence roster', () => {
    // Mirrors the existing `remoteCursorsRef` cleanup right above it — a
    // peer that vanishes without an empty 'selection' first (a crash, not
    // a clean deselect) must not lock its last selection forever.
    const presenceIdx = text.indexOf("payload.kind === 'presence'");
    const cursorIdx = text.indexOf("payload.kind === 'cursor'", presenceIdx);
    const block = text.slice(presenceIdx, cursorIdx);
    expect(block).toContain('remoteCursorsRef.current.delete(peerId)');
    expect(block).toContain('remoteSelectionsRef.current.delete(peerId)');
  });

  it('the draw pass excludes whatever a live remote drag is naming', () => {
    // Otherwise the dashed selection box would sit at the pre-drag position
    // — nothing shifts it the way `moveItems` shifts the GPU buffer — while
    // the part itself visibly slides out from under it.
    const i = text.indexOf('remoteSelectionsRef.current.size > 0');
    expect(i).toBeGreaterThan(-1);
    const block = text.slice(i, i + 700);
    expect(block).toContain('if (dragging) for (const id of dragging) ids.delete(id);');
  });

  it('keeps excluding through the gap after a committed drop, not just the live gesture', () => {
    // The bug this replaced: `remoteLiveMoveActiveRef` alone drops the
    // instant `live-move-end` arrives (it has to, for the lock — see "The
    // lock outlived its own gesture"), but for a *committed* drag
    // `boardRef` itself does not catch up until the debounced `board-patch`
    // lands. Excluding only while the flag was true reappeared the box at
    // the stale, pre-drag position for that whole gap, then snapped it once
    // the patch arrived: wrong, then late, instead of just late.
    // `remoteInPlaceRef` stays non-null across exactly that gap (cleared
    // only by the in-place hand-off when the patch lands), so it is the
    // signal that actually matches "is `boardRef` safe to trust here."
    const i = text.indexOf('const dragging =');
    expect(i).toBeGreaterThan(-1);
    const block = text.slice(i, i + 200);
    expect(block).toContain('remoteLiveMoveActiveRef.current ||');
    expect(block).toContain('remoteInPlaceRef.current !== null ||');
  });

  it('also excludes through the overlay-fallback gap, not just the in-place one', () => {
    // `remoteInPlaceRef` only ever gets set when the receiver's GL can
    // address every moved item. When it can't (no WebGL2, a lost/blocked
    // context, a reference image on the board) the gesture takes the
    // overlay-fallback branch instead, and `remoteInPlaceRef` stays null for
    // it from the start — so the exact same gap between `live-move-end` and
    // the eventual commit reopens, this time with nothing watching it.
    // `moveSceneRef` is what the fallback's own overlay paints from, and it
    // stays non-null across precisely that window (cleared only once its
    // deferred double-rAF commit lands), so it closes the gap the same way
    // `remoteInPlaceRef` does for the other path.
    const i = text.indexOf('const dragging =');
    const block = text.slice(i, i + 200);
    expect(block).toContain('moveSceneRef.current !== null');
  });
});

describe('the lock releases the instant a drag ends, not when its board-patch lands', () => {
  // Committing a real move sends its patch on the usual 400ms debounce; if
  // the lock waited for that too, a peer blocked on this exact item would
  // sit refused for the whole debounce on top of a gesture that already
  // finished. `live-move-end` has to fire unconditionally, immediately, at
  // the same point moveEnd/cancelMove already clear `liveMoveActiveRef`.

  it('moveEnd publishes end for a real move too, not just the zero-delta case', () => {
    const i = text.indexOf("kind: 'live-move-end', committed: hadRealMove");
    expect(i).toBeGreaterThan(-1);
    // The old guard this replaced: sending 'end' only `if (!hadRealMove)`.
    // Committed and uncommitted now take the same publish call, distinguished
    // by the flag, not by whether the call happens at all.
    expect(text).not.toContain(
      "if (!hadRealMove) syncTransport.current?.publish({ kind: 'live-move-end' })",
    );
  });

  it('cancelMove marks its end as uncommitted', () => {
    const i = text.indexOf("kind: 'live-move-end', committed: false");
    expect(i).toBeGreaterThan(-1);
  });

  it('a committed end returns before touching the preview it does not own yet', () => {
    // The receiver must not reverse or rebuild anything for `committed: true`
    // — that item's own 'board-patch' owns the cleanup, through the in-place
    // hand-off, when it lands moments later. Doing both would race: whichever
    // wins would either double-undo a move that already committed, or (if
    // 'end' ran first) flash the pre-drag position for the gap before the
    // patch arrives — exactly what an earlier version of this code avoided
    // by never sending 'end' for a committed move at all.
    const endIdx = text.indexOf("payload.kind === 'live-move-end'");
    const nextHandlerIdx = text.indexOf('});\n    return () => {', endIdx);
    const block = text.slice(endIdx, nextHandlerIdx);
    const committedIdx = block.indexOf('if (payload.committed)');
    const appliedIdx = block.indexOf('const applied = remoteInPlaceRef.current;');
    expect(committedIdx).toBeGreaterThan(-1);
    expect(appliedIdx).toBeGreaterThan(-1);
    expect(committedIdx).toBeLessThan(appliedIdx);
    const committedBlock = block.slice(committedIdx, appliedIdx);
    expect(committedBlock).toContain('return;');
    expect(committedBlock).not.toContain('remoteInPlaceRef.current = null');
    expect(committedBlock).not.toContain('moveSceneRef.current = null');
  });
});

describe('a newly-joined peer is welcomed with the current board', () => {
  // Requirement: joining or reconnecting brings you up to date
  // automatically (docs/proposals/multiplayer-architecture.md), rather than
  // showing whatever this tab's own local storage happened to have.
  const presenceIdx = text.indexOf("payload.kind === 'presence'");
  const snapshotIdx = text.indexOf("payload.kind === 'snapshot'", presenceIdx);
  const cursorIdx = text.indexOf("payload.kind === 'cursor'", snapshotIdx);
  const presenceBlock = text.slice(presenceIdx, snapshotIdx);
  const snapshotBlock = text.slice(snapshotIdx, cursorIdx);

  it('sends a snapshot only to a peer not already known, not to everyone', () => {
    const loopIdx = presenceBlock.indexOf('for (const peerId of stillHere)');
    expect(loopIdx).toBeGreaterThan(-1);
    const loopBlock = presenceBlock.slice(loopIdx, loopIdx + 200);
    expect(loopBlock).toContain('if (knownPeerIdsRef.current.has(peerId)) continue;');
    expect(presenceBlock).toContain("kind: 'snapshot'");
    expect(presenceBlock).toContain('toPeerId: peerId');
  });

  it('updates knownPeerIdsRef after the newcomer scan, not before', () => {
    // Scanning against the set it is about to become would never find a
    // newcomer at all — every peer already "matches" the target it hasn't
    // been assigned to yet.
    const loopIdx = presenceBlock.indexOf('for (const peerId of stillHere)');
    const assignIdx = presenceBlock.indexOf('knownPeerIdsRef.current = stillHere;');
    expect(loopIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(loopIdx);
  });

  it('ignores a snapshot addressed to someone else', () => {
    const i = snapshotBlock.indexOf('if (payload.toPeerId !== transport.peerId) return;');
    expect(i).toBeGreaterThan(-1);
    // Must be the first check — every later line in this branch assumes the
    // snapshot is actually this tab's.
    expect(snapshotBlock.slice(0, i)).not.toContain('receivedSnapshotRef');
  });

  it('accepts only the first snapshot, and none once this tab has edited', () => {
    const i = snapshotBlock.indexOf(
      'if (receivedSnapshotRef.current || hasLocalEditRef.current) return;',
    );
    expect(i).toBeGreaterThan(-1);
    expect(snapshotBlock).toContain('receivedSnapshotRef.current = true;');
  });

  it('marks the pending update deferrable, not a plain model-changed', () => {
    // Distinguishes "just a catch-up courtesy" from a real edit — a
    // 'model-changed' from an actual peer edit must always apply, even if
    // it races a local change; only the join-time snapshot may lose that
    // race and quietly keep this tab's own edit instead.
    expect(snapshotBlock).toContain(
      "setPendingRemoteBoard({ kind: 'text', text: payload.text, deferToLocalEdit: true });",
    );
  });

  it('commitBoard marks a commit as local unless it is a remote apply', () => {
    const i = text.indexOf('const commitBoard = useCallback(');
    const body = text.slice(i, i + 900);
    const flagIdx = body.indexOf('if (!applyingRemoteRef.current) hasLocalEditRef.current = true;');
    const undoIdx = body.indexOf('undoRef.current.push(prev);');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(undoIdx).toBeGreaterThan(flagIdx);
  });

  it('the deferred whole-board apply re-checks hasLocalEditRef, not just at receipt', () => {
    // The parse this feeds is off-thread (~160ms) — this tab can start its
    // own edit while a snapshot is still parsing, and that race has to be
    // caught here too, not only when the message first arrived.
    const i = text.indexOf('const deferToLocalEdit = pending.deferToLocalEdit');
    expect(i).toBeGreaterThan(-1);
    const thenIdx = text.indexOf('.then((next) => {', i);
    const commitIdx = text.indexOf('commitBoard(next);', thenIdx);
    const block = text.slice(thenIdx, commitIdx);
    expect(block).toContain('if (deferToLocalEdit && hasLocalEditRef.current) return;');
  });
});

describe('remoteAffectedRef does not outlive the drag it named', () => {
  it('the overlay-fallback commit clears it too, not just the in-place hand-off', () => {
    // The in-place hand-off (`if (remoteInPlaceRef.current) { ... }`, above
    // in this same effect) already clears both refs on its own branch. This
    // is the *other* branch — a committed drag that took the overlay
    // fallback (no WebGL2, or a board with a reference image) — which has
    // no `remoteInPlaceRef` of its own to signal "still pending," so a
    // stale `remoteAffectedRef` left here would keep excluding those ids
    // from a *later*, unrelated peer selection's box.
    const i = text.indexOf('Double rAF: the first fires');
    expect(i).toBeGreaterThan(-1);
    const rafIdx = text.indexOf('requestAnimationFrame(() => {', i);
    const closeIdx = text.indexOf('});\n      });', rafIdx);
    expect(rafIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(rafIdx);
    const block = text.slice(rafIdx, closeIdx);
    expect(block).toContain('remoteAffectedRef.current = new Set();');
  });
});
