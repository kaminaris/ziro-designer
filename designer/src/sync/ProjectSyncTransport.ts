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

/**
 * Who a connected peer is allowed to be, for this session. No upstream KiCad
 * counterpart — KiCad has no notion of a peer at all.
 *
 * `owner` is not assigned by anyone: each peer decides its own on connect,
 * by the simplest rule that needs no coordination — the first peer to find
 * nobody else already present names itself the owner of the session; every
 * later joiner starts as `editor`. That is a property of *this live
 * session*, not of the project file (see docs/proposals/
 * multiplayer-architecture.md, "Who is allowed to do what") — reconciling
 * it with real project ownership once one exists is an open question, not
 * solved here. The owner is the only one who can move someone else between
 * `editor` and `viewer` (`role-assign`, below); a `viewer` can see and
 * follow everything exactly like an `editor` (full awareness), it just
 * cannot commit an edit of its own — see `commitBoard`'s guard.
 */
export type PeerRole = 'owner' | 'editor' | 'viewer';

export interface PresenceInfo {
  peerId: string;
  view: EditorKind;
  sheetPath: string | null;
  role: PeerRole;
  /** The real name to show for this peer, when one is known (a signed-in
   *  email today — see designer/src/auth/). Null falls back to a short
   *  peerId-derived label, same as before this existed. */
  displayName: string | null;
}

/** What crosses the wire. 'presence' is never peer-authored: each transport
 *  computes it locally from the peers it has observed. */
export type ProjectSyncPayload =
  | { kind: 'model-changed'; sheetPath: string; text: string }
  /**
   * The catch-up a newly-joined peer needs (requirement: joining or
   * reconnecting has to bring you up to date automatically, not show a
   * stale copy — see docs/proposals/multiplayer-architecture.md). Sent by
   * an already-connected peer the moment it sees a new peerId in
   * 'presence', addressed to that one peer by id since a broadcast
   * transport cannot unicast. Every other peer ignores it — they are
   * already current, and re-applying a possibly-stale copy of their own
   * board would be a pointless, disruptive full commit for no reason.
   *
   * Whole-document text, the same shape as 'model-changed', because the
   * receiver has no prior state to diff a patch against yet — there is
   * nothing here for `pcb_diff.ts` to compare two boards to. `sheetPath`
   * carries the same meaning 'model-changed' gives it (PCB always uses
   * 'board'; schematic names the sheet).
   */
  | { kind: 'snapshot'; toPeerId: string; sheetPath: string; text: string }
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
   * 'delta' is the cheap, frequent update while the gesture continues.
   * The receiver never commits this — it's the same moveSceneRef + delta
   * overlay a local drag already draws with, just fed over the wire.
   *
   * 'end' always fires, the instant the gesture ends, whether or not it
   * moved anything — it is what releases the grab/selection lock
   * (`beginMove`'s `remoteLiveMoveActiveRef` check), and that has to happen
   * right away: waiting for `committed`'s own debounced 'board-patch'
   * (~400ms+) would leave a peer unable to grab the item for that whole
   * window after the gesture already finished. `committed` tells the
   * receiver whether anything else needs doing: false (grabbed and
   * released without moving, or Esc) means no 'board-patch' is coming, so
   * the preview has to be undone right here; true means one is, and it
   * will replace the preview cleanly when it lands (through the same
   * in-place hand-off a committed drag already uses) — so 'end' must NOT
   * also touch the preview then, or it flashes the pre-drag position for
   * the gap before that patch arrives.
   */
  | { kind: 'live-move-start'; patch: BoardPatch }
  | { kind: 'live-move-delta'; x: number; y: number }
  | { kind: 'live-move-end'; committed: boolean }
  | { kind: 'selection'; refs: string[] }
  | { kind: 'cursor'; x: number; y: number }
  /**
   * The session owner moving another peer between `editor` and `viewer`.
   * Addressed by `toPeerId`, the same pattern `snapshot` uses, since a
   * broadcast transport cannot unicast. Applied on the honor system: the
   * receiver adopts the assigned role and re-announces its own presence
   * with it, exactly as if it had chosen that role itself — nothing here
   * checks that the sender is really the owner, the same trust level
   * `beginMove`'s lock already runs on. Real enforcement (a client that
   * ignores this and commits anyway) needs a server that can refuse the
   * write, which is out of scope for a same-browser transport; see
   * docs/proposals/multiplayer-architecture.md.
   */
  | { kind: 'role-assign'; toPeerId: string; role: 'editor' | 'viewer' }
  /** This transport's own role just changed — an owner-election result, or
   *  an applied `role-assign`. Never peer-authored, exactly like
   *  `presence`: delivered locally (`fromPeerId` is this transport's own
   *  `peerId`) so the UI can react without polling `setRole`'s caller. */
  | { kind: 'self-role'; role: PeerRole }
  | { kind: 'presence'; peers: PresenceInfo[] };

/**
 * One project-scoped live connection. Implementations: BroadcastChannelTransport
 * today (same-browser cross-tab); a Supabase Realtime-backed transport is the
 * natural next implementation for cross-device sync, behind this same interface.
 */
export interface ProjectSyncTransport {
  readonly peerId: string;

  /**
   * `identity.displayName` is announced once and does not change for the
   * life of the connection. The role does — this connects provisionally as
   * `editor` and, if nobody else answers within a short window, promotes
   * itself to `owner` (see `PeerRole`); `setRole` is what moves it after
   * that, either from that self-election or from an incoming `role-assign`.
   */
  connect(
    view: EditorKind,
    sheetPath: string | null,
    identity: { displayName: string | null },
  ): void;

  /** Re-announces this peer's view/sheet without a full reconnect. */
  updatePresence(view: EditorKind, sheetPath: string | null): void;

  /** Re-announces this peer's own role, e.g. after an incoming `role-assign`. */
  setRole(role: PeerRole): void;

  disconnect(): void;

  publish(payload: ProjectSyncPayload): void;

  onMessage(handler: (payload: ProjectSyncPayload, fromPeerId: string) => void): () => void;
}
