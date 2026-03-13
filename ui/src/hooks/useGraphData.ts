import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphNode, GraphLink, GraphStats } from '../types/graph';
import { useStore } from '../store';

export interface GraphDataState {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  loading: boolean;
  error: string | null;
  stats: GraphStats | null;
  lastSearchQuery: string;
  loadGraph: (query?: string, hops?: number) => Promise<void>;
  setError: (error: string | null) => void;
}

export function useGraphData(onGraphLoaded?: () => void): GraphDataState {
  const { store } = useStore();
  const [graphData, setGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [lastSearchQuery, setLastApiQuery] = useState('');

  // Use a ref so loadGraph's identity doesn't depend on the callback
  const onGraphLoadedRef = useRef(onGraphLoaded);
  onGraphLoadedRef.current = onGraphLoaded;

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
    loadGraph();
  }, [loadGraph]);

  return {
    graphData,
    loading,
    error,
    stats,
    lastSearchQuery,
    loadGraph,
    setError,
  };
}
