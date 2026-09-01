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
