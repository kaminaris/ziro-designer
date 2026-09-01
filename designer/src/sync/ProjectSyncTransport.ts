// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
/**
 * Live cross-viewer sync for a project. No upstream KiCad counterpart —
 * KiCad is single-process. Adapted from KiOnline's ProjectSyncTransport,
 * which this port carries the same design intent: a transport-agnostic
 * interface so the editor code never depends on how peers actually talk to
 * each other (today: BroadcastChannel, same browser; tomorrow: a Supabase
 * Realtime channel, cross-device).
 */

import type { BoardPatch } from './pcb_diff.js';

export type EditorKind = 'schematic' | 'pcb' | 'symbol' | 'footprint';

export interface PresenceInfo {
  peerId: string;
  view: EditorKind;
  sheetPath: string | null;
}

/** What crosses the wire. 'presence' is never peer-authored: each transport
 *  computes it locally from the peers it has observed. */
export type ProjectSyncPayload =
  | { kind: 'model-changed'; sheetPath: string; text: string }
  /** A compact, uuid-keyed diff (pcb_diff.ts) — the fast path for PCB sync,
   *  used whenever every touched item carries a uuid (real KiCad files
   *  always do). Falls back to 'model-changed' (whole board text) only
   *  when that can't be trusted. No schematic equivalent yet — sheets are
   *  already small enough that whole-text sync hasn't needed this. */
  | { kind: 'board-patch'; patch: BoardPatch }
  /**
   * A live, uncommitted drag preview — PCB only, plain move/drag (not the
   * router's push-and-shove, which rebuilds stretched geometry every frame
   * even locally and isn't a good fit for streaming). 'start' names the
   * moved items once (a patch-shaped snapshot at their pre-drag position);
   * 'delta' is the cheap, frequent update while the gesture continues;
   * 'end' (or the eventual 'board-patch' the real commit sends) clears it.
   * The receiver never commits this — it's the same moveSceneRef + delta
   * overlay a local drag already draws with, just fed over the wire.
   */
  | { kind: 'live-move-start'; patch: BoardPatch }
  | { kind: 'live-move-delta'; x: number; y: number }
  | { kind: 'live-move-end' }
  | { kind: 'selection'; refs: string[] }
  | { kind: 'cursor'; x: number; y: number }
  | { kind: 'presence'; peers: PresenceInfo[] };

/**
 * One project-scoped live connection. Implementations: BroadcastChannelTransport
 * today (same-browser cross-tab); a Supabase Realtime-backed transport is the
 * natural next implementation for cross-device sync, behind this same interface.
 */
export interface ProjectSyncTransport {
  readonly peerId: string;

  connect(view: EditorKind, sheetPath: string | null): void;

  /** Re-announces this peer's view/sheet without a full reconnect. */
  updatePresence(view: EditorKind, sheetPath: string | null): void;

  disconnect(): void;

  publish(payload: ProjectSyncPayload): void;

  onMessage(handler: (payload: ProjectSyncPayload, fromPeerId: string) => void): () => void;
}
