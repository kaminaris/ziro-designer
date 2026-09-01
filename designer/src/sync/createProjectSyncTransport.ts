// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 ZiroEDA and contributors.
import type { ProjectSyncTransport } from './ProjectSyncTransport.js';
import { BroadcastChannelTransport } from './BroadcastChannelTransport.js';

/**
 * Same-browser cross-tab sync today. A Supabase Realtime-backed transport
 * (cross-device) is the natural next implementation behind this same
 * factory, once real credentials are available to test against — this
 * signature is written so swapping it in later doesn't change any call site.
 */
export function createProjectSyncTransport(projectId: string): ProjectSyncTransport {
  return new BroadcastChannelTransport(projectId);
}
