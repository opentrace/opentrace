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

import { useEffect, useRef, useState } from 'react';
import type {
  GraphNode,
  GraphLink,
  CommunityData,
  LayoutConfig,
} from './types';
import type { CommunityResponse } from '../workers/communityWorker';

const EMPTY_COMMUNITY: CommunityData = {
  assignments: {} as Record<string, number>,
  colorMap: new Map<number, string>(),
  names: new Map<number, string>(),
  count: 0,
};

/**
 * Compute Louvain communities in a Web Worker.
 * Color and naming functions are provided via layoutConfig and run on the
 * main thread after the worker returns assignments.
 */
export function useCommunities(
  allNodes: GraphNode[],
  allLinks: GraphLink[],
  layoutConfig: LayoutConfig,
): CommunityData {
  const [communityData, setCommunityData] = useState<CommunityData>(EMPTY_COMMUNITY);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (allNodes.length === 0) {
      setCommunityData(EMPTY_COMMUNITY);
      return;
    }

    // Terminate previous worker
    workerRef.current?.terminate();
    workerRef.current = null;

    const reqId = ++requestIdRef.current;

    const worker = new Worker(
      new URL('../workers/communityWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onerror = (err) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;
      console.error('[graph] community worker failed:', err);
      setCommunityData(EMPTY_COMMUNITY);
    };

    worker.onmessage = (e: MessageEvent<CommunityResponse>) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;

      const { assignments } = e.data;
      const colorMap = layoutConfig.buildCommunityColorMap(assignments);
      const names = layoutConfig.buildCommunityNames(assignments, allNodes);
      const count = new Set(Object.values(assignments)).size;

      if (process.env.NODE_ENV === 'development') {
        console.log(
          `[graph] Louvain: ${count} communities from ${allNodes.length} nodes`,
        );
      }

      setCommunityData({ assignments, colorMap, names, count });
      // Clean up worker — it's single-shot
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    // Prepare serializable data for the worker
    const nodes = allNodes.map((n) => ({ id: n.id, type: n.type }));
    const links = allLinks.map((link) => ({
      source: typeof link.source === 'string' ? link.source : (link.source as GraphNode).id,
      target: typeof link.target === 'string' ? link.target : (link.target as GraphNode).id,
      label: link.label,
    }));

    worker.postMessage({
      nodes,
      links,
      resolution: layoutConfig.louvainResolution,
    });

    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [allNodes, allLinks, layoutConfig]);

  return communityData;
}
