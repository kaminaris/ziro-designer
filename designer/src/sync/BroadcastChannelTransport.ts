// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
import type {
  EditorKind,
  PresenceInfo,
  ProjectSyncPayload,
  ProjectSyncTransport,
} from './ProjectSyncTransport.js';

type WireMessage =
  | { type: 'hello'; peerId: string; view: EditorKind; sheetPath: string | null }
  | { type: 'bye'; peerId: string }
  | { type: 'relay'; peerId: string; payload: ProjectSyncPayload };

/** Re-announce this often while connected, so a silent (crashed, or 'bye'-less
 *  closed) peer can be detected by absence rather than relying on 'bye'. */
const DEFAULT_HEARTBEAT_MS = 4000;
/** Evict a peer once it's been silent this long — a few missed heartbeats,
 *  not one, so a single delayed message doesn't flap the roster. */
const STALE_MULTIPLE = 3;

/**
 * Cross-tab transport with no central process: each tab builds its own peer
 * roster by exchanging hello/bye broadcasts. A joining tab announces itself;
 * any peer hearing a hello from someone it doesn't already know replies with
 * its own hello, so a late joiner still learns about everyone already there.
 * A peer that vanishes without sending 'bye' (a crashed tab, not a closed
 * one) is still detected and evicted, via the heartbeat/staleness sweep
 * below rather than relying on a graceful goodbye.
 */
export class BroadcastChannelTransport implements ProjectSyncTransport {
  readonly peerId = crypto.randomUUID();
  protected channel: BroadcastChannel | null = null;
  protected readonly peers = new Map<string, PresenceInfo>();
  protected readonly lastSeen = new Map<string, number>();
  protected readonly handlers = new Set<
    (payload: ProjectSyncPayload, fromPeerId: string) => void
  >();
  protected selfView: EditorKind = 'schematic';
  protected selfSheetPath: string | null = null;
  protected heartbeat: ReturnType<typeof setInterval> | null = null;
  protected readonly heartbeatMs: number;
  protected readonly staleMs: number;

  constructor(
    protected readonly projectId: string,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
  ) {
    this.heartbeatMs = heartbeatMs;
    this.staleMs = heartbeatMs * STALE_MULTIPLE;
  }

  connect(view: EditorKind, sheetPath: string | null): void {
    if (this.channel) return;
    this.selfView = view;
    this.selfSheetPath = sheetPath;
    this.channel = new BroadcastChannel(`ziro-project-sync:${this.projectId}`);
    this.channel.addEventListener('message', (event: MessageEvent<WireMessage>) =>
      this.handleWireMessage(event.data),
    );
    this.broadcastHello();
    this.heartbeat = setInterval(() => {
      this.broadcastHello();
      this.sweepStalePeers();
    }, this.heartbeatMs);
  }

  updatePresence(view: EditorKind, sheetPath: string | null): void {
    this.selfView = view;
    this.selfSheetPath = sheetPath;
    this.broadcastHello();
  }

  disconnect(): void {
    if (!this.channel) return;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.channel.postMessage({ type: 'bye', peerId: this.peerId } satisfies WireMessage);
    this.channel.close();
    this.channel = null;
    this.peers.clear();
    this.lastSeen.clear();
  }

  publish(payload: ProjectSyncPayload): void {
    this.channel?.postMessage({
      type: 'relay',
      peerId: this.peerId,
      payload,
    } satisfies WireMessage);
  }

  onMessage(handler: (payload: ProjectSyncPayload, fromPeerId: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  protected broadcastHello(): void {
    this.channel?.postMessage({
      type: 'hello',
      peerId: this.peerId,
      view: this.selfView,
      sheetPath: this.selfSheetPath,
    } satisfies WireMessage);
  }

  protected handleWireMessage(message: WireMessage): void {
    if (message.peerId === this.peerId) return;
    if (message.type === 'hello') {
      const isNewPeer = !this.peers.has(message.peerId);
      this.peers.set(message.peerId, {
        peerId: message.peerId,
        view: message.view,
        sheetPath: message.sheetPath,
      });
      this.lastSeen.set(message.peerId, Date.now());
      this.emitPresence();
      if (isNewPeer) this.broadcastHello();
      return;
    }
    if (message.type === 'bye') {
      this.lastSeen.delete(message.peerId);
      if (this.peers.delete(message.peerId)) this.emitPresence();
      return;
    }
    for (const handler of this.handlers) handler(message.payload, message.peerId);
  }

  /** Drop any peer whose last hello is older than staleMs — catches a tab
   *  that closed, crashed, or lost the network without ever sending 'bye'. */
  protected sweepStalePeers(): void {
    const now = Date.now();
    let changed = false;
    for (const [peerId, seenAt] of this.lastSeen) {
      if (now - seenAt > this.staleMs) {
        this.lastSeen.delete(peerId);
        if (this.peers.delete(peerId)) changed = true;
      }
    }
    if (changed) this.emitPresence();
  }

  protected emitPresence(): void {
    const payload: ProjectSyncPayload = { kind: 'presence', peers: [...this.peers.values()] };
    for (const handler of this.handlers) handler(payload, 'local');
  }
}
