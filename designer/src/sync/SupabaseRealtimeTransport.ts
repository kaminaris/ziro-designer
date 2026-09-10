// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
import type { SupabaseClient } from '@supabase/supabase-js';
import { cloudBackend } from '../cloud/cloudStore.js';
import type {
  EditorKind,
  PeerRole,
  PresenceInfo,
  ProjectSyncPayload,
  ProjectSyncTransport,
} from './ProjectSyncTransport.js';

/**
 * What each peer publishes about itself on the channel. Deliberately small:
 * everything here is self-reported and therefore untrusted, so the only
 * fields are the ones a peer is the sole authority on — where it is looking.
 * Identity and role are NOT taken from here; see `roster` below.
 */
interface PresenceMeta {
  peerId: string;
  userId: string;
  view: EditorKind;
  sheetPath: string | null;
  displayName: string | null;
}

/** The channel name for a project. `uid` and never `(user_id, id)`, for the
 *  reason 20260904120000_project_uid.sql gives: a name containing the owner
 *  cannot survive the project being shared. */
const channelName = (uid: string): string => `project:${uid}`;

/** One broadcast event carries every payload kind; `ProjectSyncPayload.kind`
 *  already discriminates them, and a per-kind event would mean a matching
 *  `.on()` for each and a silent drop the day one is forgotten. */
const EVENT = 'sync';

/**
 * Cross-device sync over Supabase Realtime.
 *
 * The same `ProjectSyncTransport` the same-browser `BroadcastChannelTransport`
 * implements, so no editor knows which one it is talking to. Two things are
 * genuinely different here, and both are improvements the database made
 * possible rather than choices:
 *
 * **Roles are read, not elected.** `BroadcastChannelTransport` has to invent an
 * owner (first peer to find nobody else present claims it) because a
 * same-browser channel has no authority to ask. Here `project_roster()` is that
 * authority: ownership is `projects.user_id` and membership is
 * `project_members`, both enforced by RLS. So there is no election, and a
 * `role-assign` is not an honour-system broadcast — it is a `setMemberRole`
 * call the server refuses unless the caller really is the owner.
 *
 * **Presence is per connection, not per account.** The presence key is
 * `peerId`, so somebody with the project open in two tabs is two peers, which
 * is what a cursor list has to show. Their role is the same in both, because
 * role is a fact about the account.
 *
 * Failure is not fatal, ever: multiplayer is additive (requirement 9 in
 * docs/proposals/multiplayer-architecture.md). If the channel never subscribes
 * or the roster cannot be read, this reports an empty peer list and the editor
 * carries on exactly as it does with nobody else around. It never blocks,
 * refuses or delays an edit.
 */
export class SupabaseRealtimeTransport implements ProjectSyncTransport {
  readonly peerId = crypto.randomUUID();

  private channel: ReturnType<SupabaseClient['channel']> | null = null;
  private readonly handlers = new Set<(payload: ProjectSyncPayload, fromPeerId: string) => void>();

  /** Role per `user_id`, from `project_roster()`. Empty until it answers, and
   *  empty for good on a deployment without the membership migration — which
   *  is why every read of it falls back rather than waiting. */
  private roster = new Map<string, { role: PeerRole; email: string | null }>();

  private selfView: EditorKind = 'schematic';
  private selfSheetPath: string | null = null;
  private selfDisplayName: string | null = null;
  private selfRole: PeerRole = 'editor';
  /** Last role announced to the UI, so a roster refresh only emits `self-role`
   *  when the answer actually changed. */
  private announcedRole: PeerRole | null = null;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly projectUid: string,
    private readonly userId: string,
  ) {}

  connect(
    view: EditorKind,
    sheetPath: string | null,
    identity: { displayName: string | null } = { displayName: null },
  ): void {
    if (this.channel) return;
    this.selfView = view;
    this.selfSheetPath = sheetPath;
    this.selfDisplayName = identity.displayName;

    const channel = this.supabase.channel(channelName(this.projectUid), {
      config: {
        // Keyed by connection, not by account: two tabs are two cursors.
        presence: { key: this.peerId },
        // We already know what we sent; echoing it back would make every
        // publish a message this tab has to recognise and discard.
        broadcast: { self: false },
      },
    });
    this.channel = channel;

    channel.on('presence', { event: 'sync' }, () => this.emitPresence());
    channel.on('broadcast', { event: EVENT }, ({ payload }) => {
      const wire = payload as { from: string; body: ProjectSyncPayload } | undefined;
      if (!wire?.from || !wire.body) return;
      if (wire.from === this.peerId) return; // belt and braces; `self: false` already did this
      for (const h of this.handlers) h(wire.body, wire.from);
    });

    channel.subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      void channel.track(this.meta());
    });

    // Not awaited: presence must not wait on the roster, and the roster is
    // only ever an enrichment of a peer list that is already correct.
    void this.refreshRoster();
  }

  updatePresence(view: EditorKind, sheetPath: string | null): void {
    this.selfView = view;
    this.selfSheetPath = sheetPath;
    void this.channel?.track(this.meta());
  }

  /**
   * Adopt a role locally.
   *
   * Kept for interface parity with the broadcast transport, but it is not how
   * a role changes here: the roster is the authority, so anything this sets is
   * corrected by the next refresh. The real path is an owner publishing
   * `role-assign`, which `publish` turns into a `setMemberRole` write.
   */
  setRole(role: PeerRole): void {
    this.selfRole = role;
    void this.channel?.track(this.meta());
  }

  disconnect(): void {
    const channel = this.channel;
    this.channel = null;
    this.roster.clear();
    this.announcedRole = null;
    if (channel) void this.supabase.removeChannel(channel);
  }

  publish(payload: ProjectSyncPayload): void {
    // A role change is a database write, not a message. Sending it as one
    // would be the honour system the broadcast transport is stuck with, and
    // across devices that means anybody could demote anybody.
    if (payload.kind === 'role-assign') {
      void this.assignRole(payload.toPeerId, payload.role);
      return;
    }
    void this.channel?.send({
      type: 'broadcast',
      event: EVENT,
      payload: { from: this.peerId, body: payload },
    });
  }

  onMessage(handler: (payload: ProjectSyncPayload, fromPeerId: string) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** This peer's own presence record. */
  private meta(): PresenceMeta {
    return {
      peerId: this.peerId,
      userId: this.userId,
      view: this.selfView,
      sheetPath: this.selfSheetPath,
      displayName: this.selfDisplayName,
    };
  }

  /**
   * `role-assign` addressed to a peer, applied where it is actually enforced.
   *
   * The payload names a *peer*, because that is what a cursor list shows;
   * membership names an *account*. Presence is what maps one to the other, so
   * an assignment to a peer that has since gone simply finds nothing and does
   * nothing, rather than guessing.
   */
  private async assignRole(toPeerId: string, role: 'editor' | 'viewer'): Promise<void> {
    const target = this.peers().find((p) => p.peerId === toPeerId);
    const be = cloudBackend();
    if (!target?.userId || !be?.setMemberRole) return;
    try {
      await be.setMemberRole(this.projectUid, target.userId, role);
    } catch {
      return; // the server refused: not the owner, or the row is gone
    }
    await this.refreshRoster();
  }

  /** Ask the database who is on this project and what they may do. */
  private async refreshRoster(): Promise<void> {
    const be = cloudBackend();
    if (!be?.projectRoster) return;
    let rows: { user_id: string; email: string; role: string; joined_at: string }[];
    try {
      rows = await be.projectRoster(this.projectUid);
    } catch {
      return; // no membership migration, or offline: presence still works
    }
    if (!this.channel) return; // disconnected while we were asking
    this.roster = new Map(
      rows.map((r) => [r.user_id, { role: asRole(r.role) ?? 'viewer', email: r.email || null }]),
    );
    const mine = this.roster.get(this.userId)?.role ?? 'editor';
    this.selfRole = mine;
    if (this.announcedRole !== mine) {
      this.announcedRole = mine;
      // Locally synthesised, never peer-authored — the same contract
      // `BroadcastChannelTransport` documents on its own `self-role`.
      for (const h of this.handlers) h({ kind: 'self-role', role: mine }, this.peerId);
    }
    this.emitPresence();
  }

  /** Every peer currently tracked on the channel, this tab included. */
  private peers(): PresenceMeta[] {
    const state = this.channel?.presenceState<PresenceMeta>() ?? {};
    return Object.values(state)
      .flat()
      .filter((m): m is PresenceMeta & { presence_ref: string } => !!m && !!m.peerId);
  }

  /**
   * Publish the peer list, minus this tab.
   *
   * Role and display name are taken from the roster and not from what the peer
   * said about itself: one is a database fact and the other is a claim. A peer
   * the roster has not answered for yet falls back to its own announcement,
   * which is what makes the list correct immediately and merely better later.
   */
  private emitPresence(): void {
    const peers: PresenceInfo[] = this.peers()
      .filter((m) => m.peerId !== this.peerId)
      .map((m) => {
        const known = this.roster.get(m.userId);
        return {
          peerId: m.peerId,
          view: m.view,
          sheetPath: m.sheetPath,
          role: known?.role ?? 'editor',
          displayName: known?.email ?? m.displayName,
        };
      });
    for (const h of this.handlers) h({ kind: 'presence', peers }, this.peerId);
  }
}

/** `project_role` comes back as a bare string; anything unrecognised is not
 *  quietly treated as an editor. */
function asRole(value: string): PeerRole | null {
  return value === 'owner' || value === 'editor' || value === 'viewer' ? value : null;
}
