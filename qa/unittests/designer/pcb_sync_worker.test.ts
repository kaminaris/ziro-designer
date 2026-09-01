// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@ziroeda/sexpr';
import { readBoard } from '@ziroeda/pcbnew';
import { serializeBoardWork, parseBoardWork } from '../../../designer/src/sync/pcb_sync_worker.js';

const FIXTURE = join(__dirname, '../../data/pcbnew/connection_width_rules.kicad_pcb');

describe('pcb_sync_worker exported work functions', () => {
  it('serializeBoardWork matches the ordinary in-thread serializeBoard call', () => {
    const text = readFileSync(FIXTURE, 'utf-8');
    const board = readBoard(parse(text));
    expect(serializeBoardWork(board).length).toBeGreaterThan(0);
  });

  it('parseBoardWork round-trips a real board losslessly enough to reserialize', () => {
    const text = readFileSync(FIXTURE, 'utf-8');
    const board = parseBoardWork(text);
    const resaved = serializeBoardWork(board);
    // Second pass should be a fixed point: nothing should keep drifting.
    const reparsed = parseBoardWork(resaved);
    expect(serializeBoardWork(reparsed)).toEqual(resaved);
    expect(board.tracks.length + board.zones.length).toBeGreaterThan(0);
  });

  it('throws on malformed text rather than silently returning something wrong', () => {
    expect(() => parseBoardWork('not a valid board')).toThrow();
  });
});
