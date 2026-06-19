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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphNode,
  GraphLink,
  GraphStats,
} from '@opentrace/components/utils';
import { useStore } from '../store';

export interface GraphDataState {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  loading: boolean;
  /**
   * Cold-start error — set only when a `loadGraph` failed while there
   * was no prior data on screen. Consumers typically render a full
   * error state for this (e.g. `<GraphErrorState>`).
   */
  error: string | null;
  /**
   * Warm-refresh error — set when a `loadGraph` failed while data was
   * already rendered. The previous `graphData` is preserved so the
   * existing view stays visible; consumers should surface this as a
   * non-destructive banner (Fix #2).
   */
  refreshError: string | null;
  stats: GraphStats | null;
  lastSearchQuery: string;
  /** Monotonically increasing counter — bumps after each successful loadGraph */
  graphVersion: number;
  loadGraph: (query?: string, hops?: number) => Promise<void>;
  setError: (error: string | null) => void;
  setRefreshError: (error: string | null) => void;
}

export function useGraphData(onGraphLoaded?: () => void): GraphDataState {
  const { store } = useStore();
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  }>({ nodes: [], links: [] });
  // Start in loading state if the store either has data already (WASM with
  // prior imports) OR needs an async probe to discover data (server mode).
  // This prevents the empty-state UI from flashing before the server responds.
  const [loading, setLoading] = useState(
    () => store.hasData() || !!store.ensureReady,
  );
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [lastSearchQuery, setLastApiQuery] = useState('');
  const [graphVersion, setGraphVersion] = useState(0);

  // Monotonic counter to discard stale overlapping loadGraph results.
  const loadSeqRef = useRef(0);

  // Use a ref so loadGraph's identity doesn't depend on the callback
  const onGraphLoadedRef = useRef(onGraphLoaded);
  useEffect(() => {
    onGraphLoadedRef.current = onGraphLoaded;
  });

  // Track current graphData via ref so the .catch handler below can
  // decide cold-start vs warm-refresh based on what's actually on
  // screen at the moment of failure, not the (stale) value captured
  // when loadGraph's closure was last memoized.
  const graphDataRef = useRef(graphData);
  useEffect(() => {
    graphDataRef.current = graphData;
  });

  const loadGraph = useCallback(
    (query?: string, hops: number = 0): Promise<void> => {
      // Latest-wins guard: if a newer loadGraph starts before this one
      // resolves, the stale result must not clobber the newer graph/stats.
      const seq = ++loadSeqRef.current;
      setLoading(true);
      return store
        .fetchGraph(query, hops)
        .then((data) => {
          // Stale result from an older load — a newer one started first.
          if (seq !== loadSeqRef.current) return;
          // Successful fetch clears both error tracks.
          setError(null);
          setRefreshError(null);
          setGraphData(data);
          setLoading(false);
          setLastApiQuery(query ?? '');
          setGraphVersion((v) => v + 1);
          onGraphLoadedRef.current?.();
          store
            .fetchStats()
            .then((s) => {
              if (seq === loadSeqRef.current) setStats(s);
            })
            .catch(() => {});
        })
        .catch((err) => {
          if (seq !== loadSeqRef.current) return;
          setLoading(false);
          // Swallow AbortError — clearGraph fired mid-load, expected on
          // project switch. Any real error still surfaces.
          if (err?.name === 'AbortError') return;
          // Cold start (no prior data): surface as a full error state.
          // Warm refresh (data already rendered): surface as a banner,
          // and keep the previous graph on screen. See Fix #2.
          const hadData = graphDataRef.current.nodes.length > 0;
          // Clear the opposite channel so a stale error from a prior
          // warm-refresh ↔ cold-start transition doesn't linger.
          if (hadData) {
            setError(null);
            setRefreshError(err.message);
          } else {
            setRefreshError(null);
            setError(err.message);
          }
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
    } else if (store.ensureReady) {
      // Server-backed stores don't know if data exists until they've called
      // the API. Probe the server, then load if it has data.
      let cancelled = false;
      store
        .ensureReady()
        .then(() => {
          if (cancelled) return;
          if (store.hasData()) {
            loadGraph();
          } else {
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    } else {
      setLoading(false);
    }
  }, [loadGraph, store]);

  // Memoize the returned state so context consumers (and downstream
  // memoized components) don't re-render every commit just because the
  // wrapping object changed identity. `loadGraph`/`setError` are already
  // stable (useCallback / useState dispatcher); the rest is primitive
  // state, so identity tracks the values.
  return useMemo(
    () => ({
      graphData,
      loading,
      error,
      refreshError,
      stats,
      lastSearchQuery,
      graphVersion,
      loadGraph,
      setError,
      setRefreshError,
    }),
    [
      graphData,
      loading,
      error,
      refreshError,
      stats,
      lastSearchQuery,
      graphVersion,
      loadGraph,
    ],
  );
}
