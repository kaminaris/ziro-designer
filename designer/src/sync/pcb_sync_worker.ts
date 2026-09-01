// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
/**
 * Off-main-thread parse/serialize for PCB live document sync
 * (designer/src/editors/pcb/PcbEditor.tsx).
 *
 * Measured on a real ~7.4MB board (GigaMicroEPCV2): serializeBoard ~82ms,
 * parse+readBoard ~160ms, all synchronous. On the receiving tab that means
 * every incoming remote edit blocks the main thread for a quarter-second-plus
 * — long enough to drop frames mid-gesture, which is what made a
 * just-pushed trace look like it had lost part of itself. Same fix as
 * preload_pool.ts/preload_worker.ts used for the symbol-library parse: move
 * the CPU-bound work off the thread that draws.
 *
 * Same request/response-by-id shape as preload_pool.ts, but a single
 * worker rather than a pool — sync work is one board at a time, not 223
 * independent library fetches.
 */
import { parse, serialize } from '@ziroeda/sexpr';
import { readBoard } from '@ziroeda/pcbnew';
import { serializeBoard } from '@ziroeda/pcbnew';
import type { Board } from '@ziroeda/pcbnew';

export interface SerializeRequest {
  id: number;
  type: 'serialize';
  board: Board;
}
export interface ParseRequest {
  id: number;
  type: 'parse';
  text: string;
}
export type SyncWorkerRequest = SerializeRequest | ParseRequest;

export interface SyncWorkerResult {
  id: number;
  type: 'serialize' | 'parse';
  text?: string;
  board?: Board;
  error?: string;
}

/** Exported so the main thread can run the identical work inline where
 *  there is no `Worker` (tests, and the graceful-degrade path). */
export function serializeBoardWork(board: Board): string {
  return serializeBoard(board);
}

export function parseBoardWork(text: string): Board {
  return readBoard(parse(text));
}

/** Round-trip sanity used only by the worker/pool's own tests — not on the
 *  hot path, but confirms serialize/parse agree with the shared sexpr
 *  serializer's own round-trip contract. */
export function roundTrip(board: Board): string {
  return serialize(parse(serializeBoardWork(board)));
}

interface WorkerScope {
  postMessage(message: SyncWorkerResult): void;
  onmessage: ((e: MessageEvent<SyncWorkerRequest>) => void) | null;
}

const global = globalThis as unknown as { WorkerGlobalScope?: unknown };

if (global.WorkerGlobalScope !== undefined) {
  const scope = globalThis as unknown as WorkerScope;
  scope.onmessage = (e: MessageEvent<SyncWorkerRequest>): void => {
    const req = e.data;
    try {
      if (req.type === 'serialize') {
        scope.postMessage({ id: req.id, type: 'serialize', text: serializeBoardWork(req.board) });
      } else {
        scope.postMessage({ id: req.id, type: 'parse', board: parseBoardWork(req.text) });
      }
    } catch (err) {
      scope.postMessage({ id: req.id, type: req.type, error: String(err) });
    }
  };
}
