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

import { useEffect } from 'react';
import type Graph from 'graphology';
import type { VisualState, LayoutConfig } from './types';
import {
  EDGE_SIZE_DEFAULT,
  EDGE_SIZE_DEFAULT_LINE,
  EDGE_SIZE_HIGHLIGHTED,
  EDGE_SIZE_DIMMED,
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_DIMMED,
  NODE_OPACITY_DIMMED,
} from '../config/graphLayout';

// ─── Pre-computed color cache ───────────────────────────────────────────

const dimColorCache = new Map<string, string>();

function dimColor(hex: string, alpha: number): string {
  const key = `${hex}:${alpha}`;
  const cached = dimColorCache.get(key);
  if (cached) return cached;

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // TODO: read from CSS variable for theme support
  const bgR = 0x1a,
    bgG = 0x1b,
    bgB = 0x2e;
  const nr = Math.round(r * alpha + bgR * (1 - alpha));
  const ng = Math.round(g * alpha + bgG * (1 - alpha));
  const nb = Math.round(b * alpha + bgB * (1 - alpha));
  const result = `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
  dimColorCache.set(key, result);
  return result;
}

// ─── Hook ───────────────────────────────────────────────────────────────

/**
 * Updates colors, highlights, and selection state on graph nodes/edges.
 * Color functions are read from layoutConfig to avoid coupling to a specific palette.
 * Never touches x/y positions.
 */
export function useGraphVisuals(
  graph: Graph,
  layoutReady: boolean,
  visualState: VisualState,
  layoutConfig: LayoutConfig,
  _degreeMap: Map<string, number>,
  isLargeGraph: boolean,
): void {
  useEffect(() => {
    if (!layoutReady || graph.order === 0) return;

    const {
      colorMode,
      highlightNodes,
      highlightLinks,
      labelNodes,
      selectedNodeId,
    } = visualState;

    const { getNodeColor, getLinkColor } = layoutConfig;
    const hasHighlight = highlightNodes.size > 0;

    // Batched node update — single event
    graph.updateEachNodeAttributes((_id, attrs) => {
      const isHighlighted = !hasHighlight || highlightNodes.has(_id);
      const isSelected = _id === selectedNodeId;
      const showLabel = !hasHighlight || labelNodes.has(_id);
      const baseColor =
        ((colorMode === 'community'
          ? attrs._communityColor
          : attrs._typeColor) as string | undefined) ??
        getNodeColor(attrs.nodeType as string);

      attrs.color = isHighlighted
        ? baseColor
        : dimColor(baseColor, NODE_OPACITY_DIMMED);
      attrs.borderColor = isSelected ? baseColor : undefined;
      attrs.borderSize = isSelected ? 3 : 0;
      attrs.forceLabel = showLabel && hasHighlight;
      return attrs;
    });

    // Batched edge update — single event
    const defaultEdgeSize = isLargeGraph
      ? EDGE_SIZE_DEFAULT_LINE
      : EDGE_SIZE_DEFAULT;

    graph.updateEachEdgeAttributes((_id, attrs, source, target) => {
      const linkKey = `${source}-${target}`;
      const isHighlighted = highlightLinks.has(linkKey);
      const baseColor = getLinkColor(attrs.label as string);

      if (hasHighlight) {
        attrs.color = isHighlighted
          ? baseColor
          : dimColor(baseColor, EDGE_OPACITY_DIMMED);
        attrs.size = isHighlighted ? EDGE_SIZE_HIGHLIGHTED : EDGE_SIZE_DIMMED;
      } else {
        attrs.color = dimColor(baseColor, EDGE_OPACITY_DEFAULT);
        attrs.size = defaultEdgeSize;
      }

      return attrs;
    });
  }, [graph, layoutReady, visualState, layoutConfig, isLargeGraph]);
}
