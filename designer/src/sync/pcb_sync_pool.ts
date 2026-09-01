// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
/**
 * One persistent worker for PCB sync's parse/serialize (see
 * pcb_sync_worker.ts for why). Unlike the symbol preload's pool
 * (preload_pool.ts), this is one worker, not several: sync work is one
 * board at a time, so there is nothing to parallelize — the point is only
 * to keep it off the thread that draws.
 */
import type { Board } from '@ziroeda/pcbnew';
import { serializeBoardWork, parseBoardWork, type SyncWorkerResult } from './pcb_sync_worker.js';

let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 1;
const pending = new Map<number, { resolve: (r: SyncWorkerResult) => void }>();

/** `false` in the test runner and anywhere else without module workers —
 *  callers fall back to the identical inline work either way. */
export function pcbSyncWorkerAvailable(): boolean {
  return !workerUnavailable && typeof Worker !== 'undefined';
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (!pcbSyncWorkerAvailable()) return null;
  try {
    worker = new Worker(new URL('./pcb_sync_worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<SyncWorkerResult>) => {
      const settle = pending.get(e.data.id);
      pending.delete(e.data.id);
      settle?.resolve(e.data);
    };
    worker.onerror = () => {
      for (const { resolve } of pending.values())
        resolve({ id: -1, type: 'serialize', error: 'pcb sync worker failed' });
      pending.clear();
    };
  } catch {
    workerUnavailable = true;
    worker = null;
  }
  return worker;
}

/** Serialize a board off the main thread where possible, inline where not. */
export async function serializeBoardAsync(board: Board): Promise<string> {
  const w = ensureWorker();
  if (!w) return serializeBoardWork(board);
  const id = nextId++;
  const result = await new Promise<SyncWorkerResult>((resolve) => {
    pending.set(id, { resolve });
    w.postMessage({ id, type: 'serialize', board } satisfies {
      id: number;
      type: 'serialize';
      board: Board;
    });
  });
  if (result.error !== undefined) throw new Error(result.error);
  return result.text!;
}

/** Parse a board's text off the main thread where possible, inline where not. */
export async function parseBoardAsync(text: string): Promise<Board> {
  const w = ensureWorker();
  if (!w) return parseBoardWork(text);
  const id = nextId++;
  const result = await new Promise<SyncWorkerResult>((resolve) => {
    pending.set(id, { resolve });
    w.postMessage({ id, type: 'parse', text } satisfies {
      id: number;
      type: 'parse';
      text: string;
    });
  });
  if (result.error !== undefined) throw new Error(result.error);
  return result.board!;
}
