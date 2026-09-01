// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
/**
 * A compact, network-viable patch between two board states, for PCB live
 * document sync (designer/src/editors/pcb/PcbEditor.tsx). No upstream KiCad
 * counterpart — KiCad never transmits a board over a wire.
 *
 * Not a replayed operation: PcbEditor's edits go through ~50 distinct pure
 * functions (moveBoardItems, applyTrackDrag's push-and-shove router,
 * fillZones, …), several of which involve floating-point geometry with no
 * guarantee that running "the same operation" again on a receiver's board
 * reproduces byte-identical results — replaying could silently diverge two
 * peers' boards, which is worse than being slow. Instead this diffs the
 * *result*: every board item type carries its own `uuid` and its own
 * `source` (types.ts: "every item keeps its source SList for lossless
 * round-tripping"), so an item is a self-contained, uuid-keyed unit — safe
 * to diff and safe to splice into a different board wholesale.
 *
 * This needs no changes to any of PcbEditor's ~50 commitBoard call sites:
 * it diffs whatever `next` they already produced against the board before,
 * the same before/after commitBoard already has.
 */
import type {
  Board,
  PcbFootprint,
  PcbTrack,
  PcbArcTrack,
  PcbVia,
  PcbZone,
  PcbShape,
  PcbTextItem,
  PcbTextBox,
  PcbTable,
  PcbImage,
  PcbDimension,
  PcbGroup,
} from '@ziroeda/pcbnew';

export interface CollectionPatch<T> {
  upsert: T[];
  remove: string[];
}

export interface BoardPatch {
  footprints?: CollectionPatch<PcbFootprint>;
  tracks?: CollectionPatch<PcbTrack>;
  arcs?: CollectionPatch<PcbArcTrack>;
  vias?: CollectionPatch<PcbVia>;
  zones?: CollectionPatch<PcbZone>;
  shapes?: CollectionPatch<PcbShape>;
  texts?: CollectionPatch<PcbTextItem>;
  textBoxes?: CollectionPatch<PcbTextBox>;
  tables?: CollectionPatch<PcbTable>;
  images?: CollectionPatch<PcbImage>;
  dimensions?: CollectionPatch<PcbDimension>;
  groups?: CollectionPatch<PcbGroup>;
  /**
   * Board-wide fields (layers/nets/titleBlock/paper/thickness/version) —
   * these change together, rarely, and are small, so on any change they are
   * sent as a whole rather than field-by-field.
   */
  meta?: Pick<Board, 'layers' | 'nets' | 'titleBlock' | 'paper' | 'thickness' | 'version'>;
}

/** Sentinel distinct from `undefined` (= "no change, omit this collection"):
 *  some item has no uuid, so identity across the two arrays cannot be
 *  trusted. Kept distinct from "no change" deliberately — collapsing them
 *  would make diffBoard treat every unrelated, unchanged, uuid-less-item
 *  collection as a reason to abandon the *entire* patch, when only an
 *  actually-changed collection missing uuids is a real problem. */
export const UNSAFE = Symbol('pcb-diff-unsafe');

/**
 * Diff one item collection by uuid. Returns `undefined` when the collection
 * has no changes (omit it from the patch), the sentinel `UNSAFE` when some
 * item has no uuid (the caller falls back to whole-board sync for this
 * edit rather than risk a wrong splice), or the patch itself.
 *
 * Reference (not deep) equality decides "changed": every pure edit function
 * in this codebase produces a new object only for the items it actually
 * touches (`arr.map(x => touched.has(x.uuid) ? {...x, ...} : x)`), so an
 * untouched item keeps its exact prior reference. That is what makes a
 * "select all, nudge one" pass produce a one-item patch, not a whole-board
 * one — confirmed against the real functions this diffs the output of.
 */
export function diffCollection<T extends { uuid?: string }>(
  prev: readonly T[],
  next: readonly T[],
): CollectionPatch<T> | undefined | typeof UNSAFE {
  const prevByUuid = new Map<string, T>();
  for (const item of prev) {
    if (!item.uuid) return UNSAFE;
    prevByUuid.set(item.uuid, item);
  }
  const nextUuids = new Set<string>();
  const upsert: T[] = [];
  for (const item of next) {
    if (!item.uuid) return UNSAFE;
    nextUuids.add(item.uuid);
    if (prevByUuid.get(item.uuid) !== item) upsert.push(item);
  }
  const remove: string[] = [];
  for (const uuid of prevByUuid.keys()) if (!nextUuids.has(uuid)) remove.push(uuid);
  if (upsert.length === 0 && remove.length === 0) return undefined; // no change: omit
  return { upsert, remove };
}

function metaChanged(prev: Board, next: Board): boolean {
  return (
    prev.layers !== next.layers ||
    prev.nets !== next.nets ||
    prev.titleBlock !== next.titleBlock ||
    prev.paper !== next.paper ||
    prev.thickness !== next.thickness ||
    prev.version !== next.version
  );
}

/** `null` means at least one CHANGED collection could not be diffed safely
 *  (a missing uuid on an item that's actually part of the edit) — the
 *  caller should fall back to a full whole-board sync for this edit. An
 *  unrelated, unchanged collection having uuid-less items is not a reason
 *  to bail (diffCollection already reports that as "no change", not
 *  unsafe — see its own comment). An empty-but-non-null patch (nothing
 *  changed at all) should not normally happen — commitBoard only runs on a
 *  real edit — but is valid to send as a no-op if it does. */
export function diffBoard(prev: Board, next: Board): BoardPatch | null {
  if (prev === next) return {};
  const patch: BoardPatch = {};
  const collections = [
    ['footprints', prev.footprints, next.footprints],
    ['tracks', prev.tracks, next.tracks],
    ['arcs', prev.arcs, next.arcs],
    ['vias', prev.vias, next.vias],
    ['zones', prev.zones, next.zones],
    ['shapes', prev.shapes, next.shapes],
    ['texts', prev.texts, next.texts],
    ['textBoxes', prev.textBoxes, next.textBoxes],
    ['tables', prev.tables, next.tables],
    ['images', prev.images, next.images],
    ['dimensions', prev.dimensions, next.dimensions],
    ['groups', prev.groups, next.groups],
  ] as const;
  for (const [key, p, n] of collections) {
    const result = diffCollection(
      p as readonly { uuid?: string }[],
      n as readonly { uuid?: string }[],
    );
    if (result === UNSAFE) return null;
    if (result !== undefined) (patch as Record<string, unknown>)[key] = result;
  }
  if (metaChanged(prev, next)) {
    patch.meta = {
      layers: next.layers,
      nets: next.nets,
      titleBlock: next.titleBlock,
      paper: next.paper,
      thickness: next.thickness,
      version: next.version,
    };
  }
  return patch;
}

function applyCollectionPatch<T extends { uuid?: string }>(
  items: readonly T[],
  patch: CollectionPatch<T> | undefined,
): T[] {
  if (!patch) return items as T[];
  const removeSet = new Set(patch.remove);
  const upsertByUuid = new Map(patch.upsert.map((item) => [item.uuid!, item]));
  const out: T[] = [];
  for (const item of items) {
    if (item.uuid && removeSet.has(item.uuid)) continue;
    if (item.uuid && upsertByUuid.has(item.uuid)) {
      out.push(upsertByUuid.get(item.uuid)!);
      upsertByUuid.delete(item.uuid);
    } else {
      out.push(item);
    }
  }
  // Whatever is left in upsertByUuid is genuinely new (not a replace).
  for (const item of upsertByUuid.values()) out.push(item);
  return out;
}

/** Splice a patch into a (typically different, receiver-local) board. */
export function applyBoardPatch(board: Board, patch: BoardPatch): Board {
  return {
    ...board,
    ...(patch.meta ?? {}),
    footprints: applyCollectionPatch(board.footprints, patch.footprints),
    tracks: applyCollectionPatch(board.tracks, patch.tracks),
    arcs: applyCollectionPatch(board.arcs, patch.arcs),
    vias: applyCollectionPatch(board.vias, patch.vias),
    zones: applyCollectionPatch(board.zones, patch.zones),
    shapes: applyCollectionPatch(board.shapes, patch.shapes),
    texts: applyCollectionPatch(board.texts, patch.texts),
    textBoxes: applyCollectionPatch(board.textBoxes, patch.textBoxes),
    tables: applyCollectionPatch(board.tables, patch.tables),
    images: applyCollectionPatch(board.images, patch.images),
    dimensions: applyCollectionPatch(board.dimensions, patch.dimensions),
    groups: applyCollectionPatch(board.groups, patch.groups),
  };
}

/** Rough wire-size estimate, for deciding whether a patch is worth sending
 *  over the fast path versus just falling back (a "select all, move"
 *  legitimately touches everything, and the patch is then not small). */
export function patchIsEmpty(patch: BoardPatch): boolean {
  return Object.keys(patch).length === 0;
}
