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

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GraphNode,
  GraphLink,
  GraphStats,
} from '@opentrace/components/utils';
import { useStore } from '../store';

export interface GraphDataState {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  loading: boolean;
  error: string | null;
  stats: GraphStats | null;
  lastSearchQuery: string;
  /** Monotonically increasing counter — bumps after each successful loadGraph */
  graphVersion: number;
  loadGraph: (query?: string, hops?: number) => Promise<void>;
  setError: (error: string | null) => void;
}

export function useGraphData(onGraphLoaded?: () => void): GraphDataState {
  const { store } = useStore();
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(() => store.hasData());
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [lastSearchQuery, setLastApiQuery] = useState('');
  const [graphVersion, setGraphVersion] = useState(0);

  // Use a ref so loadGraph's identity doesn't depend on the callback
  const onGraphLoadedRef = useRef(onGraphLoaded);
  useEffect(() => {
    onGraphLoadedRef.current = onGraphLoaded;
  });

  const loadGraph = useCallback(
    (query?: string, hops: number = 0): Promise<void> => {
      setLoading(true);
      return store
        .fetchGraph(query, hops)
        .then((data) => {
          setError(null);
          setGraphData(data);
          setLoading(false);
          setLastApiQuery(query ?? '');
          setGraphVersion((v) => v + 1);
          onGraphLoadedRef.current?.();
          store
            .fetchStats()
            .then(setStats)
            .catch(() => {});
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    },
    [store],
  );

  useEffect(() => {
    // Only fetch on mount if the DB has been initialized (i.e. data has been
    // imported before). Skip the initial fetch for fresh sessions — this avoids
    // triggering WASM worker init (8+ seconds) before the user adds a repo.
    if (store.hasData()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch on mount
      loadGraph();
    } else {
      setLoading(false);
    }
  }, [loadGraph, store]);

  return {
    graphData,
    loading,
    error,
    stats,
    lastSearchQuery,
    graphVersion,
    loadGraph,
    setError,
  };
}
