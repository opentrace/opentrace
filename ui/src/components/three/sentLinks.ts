/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Tracking of which links have already been handed to ThreeRenderer, so
 * incremental (non-liveGrow) updates can diff a full link list against what
 * the renderer holds. Endpoint-membership ("touches a new node") is NOT a
 * reliable new-link test: the pipeline's resolve stage emits CALLS/IMPORTS
 * edges between nodes that BOTH streamed in earlier batches (mirrors
 * useForceLayout3d's takeUnsentLinks, which solves the same problem for the
 * layout worker).
 */

import type { GraphLink } from '../graph/types';
import type { AppendTracker } from './appendPrefix';

/** Renderer-side link identity — must match the `edgeKeySet` keys built in
 *  ThreeRenderer.buildEdges / appendLiveEdges. */
export function renderLinkKey(link: GraphLink): string {
  const s =
    typeof link.source === 'string'
      ? link.source
      : (link.source as { id: string }).id;
  const t =
    typeof link.target === 'string'
      ? link.target
      : (link.target as { id: string }).id;
  return `${s}-${link.label}-${t}`;
}

/** Return the links whose key is not yet in `sent`, recording them as sent.
 *  A plain set (not a multiset) suffices here because the renderer dedups
 *  multi-edges by this same key anyway.
 *
 *  `tracker` (optional) enables the append fast path: when `links` provably
 *  extends the array processed by the previous call, the prefix is skipped —
 *  every call scans its whole region into `sent`, so all prefix keys are
 *  already there and re-scanning them can only produce skips. The per-link
 *  `sent.has` check is kept on the suffix, so even a key that re-appears is
 *  still deduped — the fast path only skips work, never changes the output.
 *  Callers must reset the tracker whenever `sent` is replaced/cleared, and
 *  must not share one tracker across different `sent` sets. */
export function takeUnsentRenderLinks(
  links: GraphLink[],
  sent: Set<string>,
  tracker?: AppendTracker<GraphLink>,
): GraphLink[] {
  let start = 0;
  if (tracker) {
    const suffix = tracker.suffixStart(links);
    if (suffix > 0) start = suffix;
  }
  const out: GraphLink[] = [];
  for (let i = start; i < links.length; i++) {
    const link = links[i];
    const key = renderLinkKey(link);
    if (sent.has(key)) continue;
    sent.add(key);
    out.push(link);
  }
  return out;
}
