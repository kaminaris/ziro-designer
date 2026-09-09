// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
/**
 * PeerRole wiring in the PCB editor (designer/src/sync/ProjectSyncTransport.ts):
 * a viewer's own edits are refused, an owner's role-assign only lands on the
 * peer it names, and this tab's own role stays in step with the transport's
 * owner-election / applied role-assign via the locally-synthesized
 * 'self-role' message.
 *
 * PcbEditor.tsx is a .tsx qa's tsconfig cannot compile standalone, and too
 * large to mount — read as text and asserted on directly, the same way
 * pcb_move_ghost.test.ts does for the sync wiring next to this.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const text = readFileSync(
  fileURLToPath(new URL('../../../designer/src/editors/pcb/PcbEditor.tsx', import.meta.url)),
  'utf8',
);

describe('a viewer cannot originate an edit', () => {
  it('commitBoard refuses a local commit while viewer, but not a remote one', () => {
    const i = text.indexOf('const commitBoard = useCallback(');
    const body = text.slice(i, i + 900);
    expect(body).toContain(
      "if (!applyingRemoteRef.current && myRoleRef.current === 'viewer') return;",
    );
    // Must come before hasLocalEditRef is ever set, or a refused commit
    // would still mark this tab as having local work in flight.
    const guardIdx = body.indexOf('if (!applyingRemoteRef.current && myRoleRef.current');
    const localEditIdx = body.indexOf('hasLocalEditRef.current = true');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(localEditIdx).toBeGreaterThan(guardIdx);
  });

  it('beginMove refuses to start the gesture at all for a viewer', () => {
    const i = text.indexOf('const beginMove = (');
    const promoteIdx = text.indexOf('promotePadsForCommand(brd, sel0)', i);
    const body = text.slice(i, promoteIdx);
    expect(body).toContain("if (myRoleRef.current === 'viewer') return;");
  });
});

describe('the transport keeps this tab in step with its own role', () => {
  it("connects with this tab's real identity", () => {
    const i = text.indexOf("transport.connect('pcb', null,");
    expect(i).toBeGreaterThan(-1);
    expect(text.slice(i, i + 80)).toContain('{ displayName: myDisplayName }');
  });

  it("applies a 'self-role' message to React state, not just a ref", () => {
    const i = text.indexOf("payload.kind === 'self-role'");
    expect(i).toBeGreaterThan(-1);
    const body = text.slice(i, i + 600);
    expect(body).toContain('setMyRole(payload.role)');
  });

  it("only applies a 'role-assign' addressed to this peer", () => {
    const i = text.indexOf("payload.kind === 'role-assign'");
    expect(i).toBeGreaterThan(-1);
    // Bounded to the next branch — 'snapshot' right after it has the exact
    // same addressing-check string for its own toPeerId, so an unbounded
    // window would still pass with this branch's own check deleted.
    const nextBranch = text.indexOf("else if (payload.kind === 'snapshot')", i);
    const body = text.slice(i, nextBranch);
    expect(body).toContain('if (payload.toPeerId !== transport.peerId) return;');
    expect(body).toContain('syncTransport.current?.setRole(payload.role);');
  });

  it('myRoleRef is kept in sync with the myRole state, every render', () => {
    const i = text.indexOf('const [myRole, setMyRole] = useState<PeerRole>');
    expect(i).toBeGreaterThan(-1);
    const body = text.slice(i, i + 200);
    expect(body).toContain('const myRoleRef = useRef<PeerRole>');
    expect(body).toContain('myRoleRef.current = myRole;');
  });
});

describe('the presence panel only lets the owner reassign roles', () => {
  it('passes onSetRole through to a role-assign publish', () => {
    const i = text.indexOf('<PresencePanel');
    expect(i).toBeGreaterThan(-1);
    const body = text.slice(i, text.indexOf('/>', i) + 2);
    expect(body).toContain("kind: 'role-assign', toPeerId: peerId, role");
  });

  it('shows a view-only notice while this tab is a viewer', () => {
    const i = text.indexOf("myRole === 'viewer' && (");
    expect(i).toBeGreaterThan(-1);
    expect(text.slice(i, i + 200)).toContain('<ReadOnlyNotice');
  });
});

describe('remote cursors and selection boxes are colored per peer, not one shared color', () => {
  it('no REMOTE_CURSOR_COLOR literal survives — peerColor replaced it everywhere', () => {
    expect(text).not.toContain('REMOTE_CURSOR_COLOR');
    expect(text).toContain("import { peerColor } from '../../sync/peerColor.js';");
  });

  it("the remote selection box's stroke and label both use this peer's own color", () => {
    const i = text.indexOf('for (const [peerId, uuids] of remoteSelectionsRef.current)');
    expect(i).toBeGreaterThan(-1);
    const body = text.slice(i, text.indexOf('remoteCursorsRef.current.size > 0', i));
    expect(body).toContain('const color = peerColor(peerId);');
    expect(body).toContain('ctx.strokeStyle = color;');
    expect(body).toContain('ctx.fillStyle = color;');
  });

  it("the remote cursor dot and label both use this peer's own color", () => {
    const i = text.indexOf('for (const [peerId, pos] of remoteCursorsRef.current)');
    expect(i).toBeGreaterThan(-1);
    const body = text.slice(i, i + 500);
    expect(body).toContain('const color = peerColor(peerId);');
    // Both fillStyle assignments in this loop must read the per-peer
    // variable, not a shared constant, or the arc and its label could
    // silently disagree about which peer they belong to.
    expect(body.match(/ctx\.fillStyle = color;/g)).toHaveLength(2);
  });
});
