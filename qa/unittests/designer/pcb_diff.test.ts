// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@ziroeda/sexpr';
import { readBoard, moveBoardItems, deleteBoardItems } from '@ziroeda/pcbnew';
import type { Board } from '@ziroeda/pcbnew';
import {
  diffBoard,
  applyBoardPatch,
  diffCollection,
  patchIsEmpty,
  UNSAFE,
} from '../../../designer/src/sync/pcb_diff.js';

const FIXTURE = join(
  __dirname,
  '../../unittests/designer/fixtures/Arduino_Uno_kicad6/Arduino_Uno.kicad_pcb',
);

function loadBoard(): Board {
  return readBoard(parse(readFileSync(FIXTURE, 'utf-8')));
}

describe('diffBoard / applyBoardPatch', () => {
  it('an unchanged board diffs to an empty patch', () => {
    const board = loadBoard();
    const patch = diffBoard(board, board);
    expect(patch).not.toBeNull();
    expect(patchIsEmpty(patch!)).toBe(true);
  });

  it('moving one footprint produces a patch touching only that footprint, not the whole board', () => {
    const board = loadBoard();
    const target = board.footprints[0]!;
    expect(target.uuid).toBeTruthy();
    const next = moveBoardItems(board, new Set(['footprint:0']), {
      x: 1000000,
      y: 500000,
    });

    const patch = diffBoard(board, next);
    expect(patch).not.toBeNull();

    // Whichever id shape moveBoardItems actually keys on, the touched count
    // must be small — a one-item move must not turn into a whole-board patch.
    const touched = patch!.footprints?.upsert.length ?? 0;
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThan(board.footprints.length);

    // Untouched collections must be entirely absent from the patch.
    expect(patch!.tracks).toBeUndefined();
    expect(patch!.zones).toBeUndefined();
  });

  it('a patch applied to the SAME prior board reproduces the post-edit board exactly', () => {
    const board = loadBoard();
    const target = board.footprints[0]!;
    const next = moveBoardItems(board, new Set(['footprint:0']), {
      x: 1000000,
      y: 500000,
    });
    const patch = diffBoard(board, next);
    const applied = applyBoardPatch(board, patch!);
    expect(applied.footprints).toEqual(next.footprints);
    expect(applied.footprints.length).toBe(next.footprints.length);
  });

  it('a patch applied to a DIFFERENT (receiver-local) board still lands correctly by uuid', () => {
    // Simulates the real cross-tab case: sender's `next` is diffed against
    // sender's `prev`, but applied against the receiver's own board object
    // — a different reference, same content (as two tabs loading the same
    // file would have).
    const senderPrev = loadBoard();
    const receiverBoard = loadBoard();
    const target = senderPrev.footprints[0]!;
    const senderNext = moveBoardItems(senderPrev, new Set(['footprint:0']), {
      x: 1000000,
      y: 500000,
    });
    const patch = diffBoard(senderPrev, senderNext);
    const patched = applyBoardPatch(receiverBoard, patch!);
    const movedOnReceiver = patched.footprints.find((f) => f.uuid === target.uuid);
    const movedOnSender = senderNext.footprints.find((f) => f.uuid === target.uuid);
    expect(movedOnReceiver).toEqual(movedOnSender);
    // The move actually has to have happened, or this test proves nothing.
    expect(movedOnReceiver!.at).not.toEqual(target.at);
    // Everything else on the receiver's board is untouched by identity.
    for (let i = 0; i < receiverBoard.footprints.length; i++) {
      if (receiverBoard.footprints[i]!.uuid === target.uuid) continue;
      expect(patched.footprints[i]).toBe(receiverBoard.footprints[i]);
    }
  });

  it('a deletion produces a remove-only patch and the item is gone after applying', () => {
    const board = loadBoard();
    const target = board.footprints[0]!;
    const next = deleteBoardItems(board, new Set(['footprint:0']));
    const patch = diffBoard(board, next);
    expect(patch).not.toBeNull();
    const applied = applyBoardPatch(board, patch!);
    expect(applied.footprints.some((f) => f.uuid === target.uuid)).toBe(false);
    expect(applied.footprints.length).toBe(board.footprints.length - 1);
  });

  it('diffCollection distinguishes "no change" (undefined) from "unsafe" (missing uuid)', () => {
    const withUuid: Array<{ uuid?: string; v: number }> = [{ uuid: 'a', v: 1 }];
    const changedUuid: Array<{ uuid?: string; v: number }> = [{ uuid: 'a', v: 2 }];
    const withoutUuid: Array<{ uuid?: string; v: number }> = [{ uuid: undefined, v: 1 }];
    expect(diffCollection(withUuid, withUuid)).toBeUndefined(); // same array, no change
    expect(diffCollection(withUuid, changedUuid)).toEqual({ upsert: changedUuid, remove: [] });
    expect(diffCollection(withoutUuid, withUuid)).toBe(UNSAFE);
    expect(diffCollection(withUuid, withoutUuid)).toBe(UNSAFE);
  });
});
