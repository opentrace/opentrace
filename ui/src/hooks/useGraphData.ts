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
import type {
  IndexedNode,
  IndexedRelationship,
} from '../gen/opentrace/v1/agent_service';
import { useStore } from '../store';
import { isConstrainedDevice, MOBILE_LIVE_NODE_CAP } from '../config/device';

// ─── Live-build streaming ──────────────────────────────────────────────────
// During browser indexing the pipeline streams node/relationship batches as
// they're produced. We buffer + flush them to React state so the graph grows
// during indexing; the renderer's live-build mode animates each batch in (new
// nodes fly out from their parent) without restarting. Flush eagerly on a node
// count threshold — the timer alone is starved by the main-thread pipeline.
// The renderer APPENDS each batch in place (no geometry rebuild), so we METER
// big incoming deltas into small chunks across ticks for a continuous,
// fine-grained build wave (the pipeline delivers nodes in big bursts).
const LIVE_FLUSH_MS = 70;
/** Max nodes revealed per flush — small = a finer, more continuous wave. */
const LIVE_FLUSH_CHUNK = 220;

// ─── Progressive ("dynamic") loading ──────────────────────────────────────
// For large browser-indexed graphs, load a structural skeleton first (fast to
// render + lay out), then stream the bulk in background pages that append to
// the live graph. See LARGE_GRAPH_LOADING_PLAN.md.

/** Structural scaffold loaded up front — kept DELIBERATELY minimal (repo +
 *  directory tree only). Files are NOT here: a big repo (Grafana ~15k files)
 *  would make the "skeleton" itself huge and slow. Files/Classes/Functions/etc.
 *  all stream as leaves, parent-first (see LEAF_TYPE_PRIORITY). */
const SKELETON_TYPES = ['Repository', 'Repo', 'Directory'];

/** Streaming order for leaf types — load containers before their contents so
 *  the graph looks connected as it grows (edges resolve once both ends load
 *  regardless, but this keeps fewer leaves briefly "floating"). */
const LEAF_TYPE_PRIORITY: Record<string, number> = {
  Module: 0,
  Namespace: 0,
  Package: 0,
  File: 1,
  Class: 2,
  Interface: 2,
  Struct: 2,
  Enum: 2,
  Function: 3,
  Method: 3,
  Variable: 4,
  Field: 4,
  Property: 4,
};
function leafRank(t: string): number {
  return LEAF_TYPE_PRIORITY[t] ?? 2.5;
}
/** Below this total node count, just one-shot load — not worth streaming. */
const PROGRESSIVE_MIN_NODES = 8000;
/** Nodes per DB page (query granularity). */
const STREAM_BATCH = 4000;
/** Pause between pages so the main thread + layout stay responsive. */
const STREAM_YIELD_MS = 16;
/** Flush accumulated pages to React state (→ one renderer update) once this
 *  many nodes are pending, or FLUSH_MS has elapsed — whichever first. Keeps the
 *  number of renderer updates to a handful regardless of page count. */
const FLUSH_NODES = 10000;
const FLUSH_MS = 600;

/** `?progressive=1` enables the progressive path (opt-in / testing). */
const PROGRESSIVE_FLAG =
  typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('progressive')
    : null;

/** Whether progressive (skeleton-first streaming) loading is active. Exposed so
 *  the build animation can be suppressed during it — a burst wants a complete,
 *  settled graph, but streaming delivers a growing one (they'd fight: the burst
 *  plays on the skeleton, then the rest streams in and the 3D layout develops,
 *  reading as a flat-plane-expanding-to-3D). Proper integration is deferred. */
export const PROGRESSIVE_LOAD_ENABLED = PROGRESSIVE_FLAG === '1';

function endpointId(e: string | { id: string }): string {
  return typeof e === 'string' ? e : e.id;
}

function linkKey(l: GraphLink): string {
  return `${endpointId(l.source)}|${l.label}|${endpointId(l.target)}`;
}

/** The visualization node cap (Settings → localStorage), used as the streaming
 *  ceiling so a >cap graph stops loading at the same point one-shot would. */
function readMaxVisNodes(): number {
  try {
    const v = Number(localStorage.getItem('ot:maxVisNodes'));
    return Number.isFinite(v) && v > 0 ? v : 50000;
  } catch {
    return 50000;
  }
}

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
  /** True while the graph is building live from an in-progress index job. Drives
   *  the renderer's live-build mode + defers per-batch community recompute. */
  isStreaming: boolean;
  /** Begin live-build: clear the graph and start accepting streamed batches. */
  startLiveStream: () => void;
  /** Append a streamed batch of nodes/relationships to the building graph. */
  pushLiveBatch: (
    nodes: IndexedNode[],
    relationships: IndexedRelationship[],
  ) => void;
  /** End live-build. Keeps the built graph; pass `{ clear: true }` to wipe it
   *  (job cancelled). `reload` controls the follow-up load from the store:
   *  `true` forces it (cancel / recoverable error — the store is intact and
   *  authoritative), `false` forbids it (OOM — another store query would
   *  crash the tab), and unset reloads only when the store already held data
   *  before this job (so a second repo doesn't leave the first off screen). */
  endLiveStream: (opts?: { clear?: boolean; reload?: boolean }) => void;
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
  const [isStreaming, setIsStreaming] = useState(false);

  // Monotonic counter to discard stale overlapping loadGraph results.
  const loadSeqRef = useRef(0);

  // ── Live-build streaming buffers ──────────────────────────────────────────
  const liveActiveRef = useRef(false);
  // Whether the store already held data when the live stream started — a live
  // stream only carries the CURRENT job's nodes, so ending on a pre-populated
  // store means the on-screen graph is a subset and needs an authoritative
  // reload (see endLiveStream).
  const hadPriorDataRef = useRef(false);
  const liveSeenNodes = useRef<Set<string>>(new Set());
  const liveSeenLinks = useRef<Set<string>>(new Set());
  const livePendNodes = useRef<GraphNode[]>([]);
  const livePendLinks = useRef<GraphLink[]>([]);
  // Edges whose endpoints haven't both arrived — held back (a dangling edge
  // crashes d3-force-3d), promoted once both ends exist.
  const liveDeferredLinks = useRef<GraphLink[]>([]);
  const liveFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ceiling on how many nodes the live stream feeds into React state / the
  // layout worker / the renderer. Infinite on desktop; bounded on a phone so a
  // huge repo's working set doesn't OOM the tab (it keeps indexing into the
  // store — only the on-screen graph stops growing). Captured per stream.
  const liveNodeCap = useRef<number>(Number.POSITIVE_INFINITY);
  const liveCapNotified = useRef(false);

  const flushLive = useCallback(() => {
    const pn = livePendNodes.current;
    const pl = livePendLinks.current;
    if (!pn.length && !pl.length) return;
    // Meter: reveal a chunk of nodes per flush so a big burst ripples in as a
    // continuous wave. Each flush triggers a layout rebuild in the worker, so
    // the chunk grows with the graph — keeping the TOTAL number of flushes
    // (hence worker rebuilds) bounded (~20) on huge repos like Grafana, instead
    // of hundreds of tiny flushes that tank indexing. Flush ALL pending links —
    // the renderer's append picks up any with not-yet-present endpoints later.
    const chunk = Math.max(
      LIVE_FLUSH_CHUNK,
      Math.floor(liveSeenNodes.current.size * 0.05),
    );
    const ns = pn.splice(0, chunk);
    const ls = pl.splice(0, pl.length);
    setGraphData((prev) => ({
      nodes: ns.length ? prev.nodes.concat(ns) : prev.nodes,
      links: ls.length ? prev.links.concat(ls) : prev.links,
    }));
    // More buffered? keep the wave going. EACH flush costs O(total nodes) on
    // the main thread (React reconcile + the interaction provider's per-type /
    // filtered-graph recomputes + the canvas's id-diff), so on a big graph
    // flushing every 70ms starves the parse-worker dispatch and throughput
    // collapses as the graph grows. Scale the interval up with graph size:
    // small graphs stay a fine 70ms wave; huge ones (Grafana) flush ~3×/s so
    // the main thread stays free for parsing. (The chunk grows too, so the
    // graph still keeps up — just in fewer, larger, cheaper-per-node batches.)
    if (pn.length && !liveFlushTimer.current) {
      const interval = Math.min(
        350,
        LIVE_FLUSH_MS + liveSeenNodes.current.size * 0.005,
      );
      liveFlushTimer.current = setTimeout(() => {
        liveFlushTimer.current = null;
        flushLive();
      }, interval);
    }
  }, []);

  const startLiveStream = useCallback(() => {
    loadSeqRef.current++; // invalidate any in-flight loadGraph
    liveActiveRef.current = true;
    hadPriorDataRef.current = store.hasData();
    liveSeenNodes.current = new Set();
    liveSeenLinks.current = new Set();
    livePendNodes.current = [];
    livePendLinks.current = [];
    liveDeferredLinks.current = [];
    liveNodeCap.current = isConstrainedDevice()
      ? MOBILE_LIVE_NODE_CAP
      : Number.POSITIVE_INFINITY;
    liveCapNotified.current = false;
    setError(null);
    setRefreshError(null);
    setGraphData({ nodes: [], links: [] });
    setLoading(false);
    setIsStreaming(true);
  }, [store]);

  const pushLiveBatch = useCallback(
    (nodes: IndexedNode[], relationships: IndexedRelationship[]) => {
      if (!liveActiveRef.current) return;
      const seen = liveSeenNodes.current;
      const cap = liveNodeCap.current;
      let addedNode = false;
      for (const n of nodes) {
        if (seen.has(n.id)) continue;
        // Constrained device: once the working set hits the cap, stop feeding new
        // nodes to the heap / layout worker / renderer. Indexing continues into
        // the store, so the full graph stays queryable — only the live view is
        // bounded.
        if (seen.size >= cap) {
          if (!liveCapNotified.current) {
            liveCapNotified.current = true;
            console.info(
              `[opentrace] Live graph capped at ${cap} nodes to fit this device's memory; the full repo keeps indexing into the store and remains searchable.`,
            );
          }
          break;
        }
        seen.add(n.id);
        addedNode = true;
        // The stream carries only the lean sub-type fields (language / kind /
        // registry — what the filter chips and default-hide read); the full
        // property blobs stay out of the JS heap (they OOM the tab on huge
        // repos) and are fetched on demand per node instead.
        const node: GraphNode = { id: n.id, name: n.name, type: n.type };
        if (n.propertiesJson) {
          try {
            node.properties = JSON.parse(n.propertiesJson) as Record<
              string,
              unknown
            >;
          } catch {
            // lean stream — a malformed blob just means no sub-type chips
          }
        }
        livePendNodes.current.push(node);
      }
      // Once the node cap is reached no further nodes will be seen, so a link
      // with a missing endpoint can never resolve — drop it (without even
      // remembering it) instead of deferring it forever, which would grow both
      // the deferred array and the dedup set unbounded with dropped edges.
      const atCap = seen.size >= cap;
      for (const r of relationships) {
        const bothSeen = seen.has(r.sourceId) && seen.has(r.targetId);
        if (!bothSeen && atCap) continue;
        const key = `${r.sourceId}|${r.type}|${r.targetId}`;
        if (liveSeenLinks.current.has(key)) continue;
        liveSeenLinks.current.add(key);
        const link: GraphLink = {
          source: r.sourceId,
          target: r.targetId,
          label: r.type,
        };
        if (bothSeen) {
          livePendLinks.current.push(link);
        } else {
          liveDeferredLinks.current.push(link);
        }
      }
      if (addedNode && liveDeferredLinks.current.length) {
        const stillDeferred: GraphLink[] = [];
        for (const l of liveDeferredLinks.current) {
          if (seen.has(l.source) && seen.has(l.target)) {
            livePendLinks.current.push(l);
          } else {
            stillDeferred.push(l);
          }
        }
        liveDeferredLinks.current = stillDeferred;
      }
      if (!liveFlushTimer.current) {
        liveFlushTimer.current = setTimeout(() => {
          liveFlushTimer.current = null;
          flushLive();
        }, LIVE_FLUSH_MS);
      }
    },
    [flushLive],
  );

  // loadGraph is declared below (it needs the error/success plumbing defined
  // around it); the live-stream callbacks above/below only ever call it after
  // mount, so a ref bridges the ordering.
  const loadGraphRef = useRef<GraphDataState['loadGraph'] | null>(null);

  const endLiveStream = useCallback(
    (opts?: { clear?: boolean; reload?: boolean }) => {
      if (!liveActiveRef.current) return;
      liveActiveRef.current = false;
      if (liveFlushTimer.current) {
        clearTimeout(liveFlushTimer.current);
        liveFlushTimer.current = null;
      }
      if (opts?.clear) {
        livePendNodes.current = [];
        livePendLinks.current = [];
        setGraphData({ nodes: [], links: [] });
        // A cancelled job leaves the store intact (batches were flushed as
        // they were produced) — reload it so the canvas doesn't blank out and
        // bounce the user to the Add Repo modal over a perfectly good graph.
        if (opts.reload !== false && store.hasData()) {
          loadGraphRef.current?.();
        }
      } else {
        // Flush ALL remaining (bypass metering) so the final graph is complete.
        const ns = livePendNodes.current;
        const ls = livePendLinks.current;
        livePendNodes.current = [];
        livePendLinks.current = [];
        if (ns.length || ls.length) {
          setGraphData((prev) => ({
            nodes: ns.length ? prev.nodes.concat(ns) : prev.nodes,
            links: ls.length ? prev.links.concat(ls) : prev.links,
          }));
        }
        // The live-built graph IS the authoritative graph when this job was
        // the only content (the common single-repo case) — bump the version so
        // presets apply + load stats, WITHOUT a loadGraph that would replace
        // graphData and reshuffle the layout the user just watched build.
        // (GraphViewer skips its post-index loadGraph for these.)
        //
        // graphData is deliberately kept LEAN — the live stream carries only
        // id/name/type + the small sub-type fields for nodes and
        // source/target/label for links, NOT the property blobs. On a huge
        // repo (e.g. Grafana, ~50k nodes / 100k+ edges) holding every property
        // blob in the JS heap — on top of the WASM DB, the force-layout
        // worker, and the renderer buffers — is what OOM-crashes the tab (it
        // self-reloads). Properties are fetched on demand (per selected node,
        // via the store's LRU-cached getNode) in SidePanel instead, so we
        // render EVERY node without ever materializing the full property set
        // in memory.
        setGraphVersion((v) => v + 1);
        store
          .fetchStats()
          .then(setStats)
          .catch(() => {});
        // BUT: the stream only carried THIS job's nodes. If the store held
        // other data before the job (a second repo, a re-index over existing
        // content) or the caller demands it (recoverable job error — the
        // stream may have died mid-graph), the on-screen graph is a subset;
        // reload the authoritative store graph, accepting the relayout.
        // reload === false (OOM) forbids touching the store again.
        if (
          opts?.reload !== false &&
          (opts?.reload || hadPriorDataRef.current) &&
          store.hasData()
        ) {
          loadGraphRef.current?.();
        }
      }
      liveDeferredLinks.current = [];
      liveSeenNodes.current = new Set();
      liveSeenLinks.current = new Set();
      setIsStreaming(false);
    },
    [store],
  );

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
      // Streaming loops also check `seq` between awaits to stop early.
      const seq = ++loadSeqRef.current;
      setLoading(true);

      const applySuccess = (
        data: { nodes: GraphNode[]; links: GraphLink[] },
        q?: string,
      ) => {
        if (seq !== loadSeqRef.current) return;
        setError(null);
        setRefreshError(null);
        setGraphData(data);
        setLoading(false);
        setLastApiQuery(q ?? '');
        setGraphVersion((v) => v + 1);
        onGraphLoadedRef.current?.();
        store
          .fetchStats()
          .then((s) => {
            if (seq === loadSeqRef.current) setStats(s);
          })
          .catch(() => {});
      };

      const applyError = (err: { name?: string; message: string }) => {
        if (seq !== loadSeqRef.current) return;
        setLoading(false);
        // Swallow AbortError — clearGraph fired mid-load, expected on
        // project switch. Any real error still surfaces.
        if (err?.name === 'AbortError') return;
        // Cold start (no prior data): full error state. Warm refresh (data
        // already rendered): non-destructive banner, keep the graph (Fix #2).
        const hadData = graphDataRef.current.nodes.length > 0;
        if (hadData) {
          setError(null);
          setRefreshError(err.message);
        } else {
          setRefreshError(null);
          setError(err.message);
        }
      };

      // Progressive path — OPT-IN via `?progressive=1` only, for now. The
      // naive per-batch append regresses huge graphs (each addData rebuilds the
      // whole renderer via setData, and useCommunities re-runs Louvain on every
      // batch), so it is NOT auto-enabled until those are fixed (incremental
      // GPU append + debounced community recompute). Search/filter (query set)
      // and non-capable stores always take the one-shot path.
      const canStream = !!store.fetchGraphSkeleton && !!store.fetchGraphPage;
      if (!query && canStream && PROGRESSIVE_LOAD_ENABLED) {
        return runProgressive(seq, applySuccess, applyError);
      }

      return store
        .fetchGraph(query, hops)
        .then((data) => applySuccess(data, query))
        .catch(applyError);

      // ── progressive implementation (closes over store + setters + seq) ──
      async function runProgressive(
        loadSeq: number,
        onDone: (d: { nodes: GraphNode[]; links: GraphLink[] }) => void,
        onErr: (e: { name?: string; message: string }) => void,
      ): Promise<void> {
        try {
          const stats = await store.fetchStats();
          if (loadSeq !== loadSeqRef.current) return;
          const total = stats.total_nodes ?? 0;
          const byType = stats.nodes_by_type ?? {};

          // Not big enough to bother streaming → one-shot (unless forced).
          if (PROGRESSIVE_FLAG !== '1' && total < PROGRESSIVE_MIN_NODES) {
            const data = await store.fetchGraph();
            onDone(data);
            return;
          }

          // 1) Skeleton — first paint + (eventual) build-animation target.
          const skeletonTypes = SKELETON_TYPES.filter(
            (t) => (byType[t] ?? 0) > 0,
          );
          const skel = await store.fetchGraphSkeleton!(skeletonTypes);
          if (loadSeq !== loadSeqRef.current) return;
          setError(null);
          setRefreshError(null);
          setGraphData(skel);
          setLoading(false); // graph is interactive now; streaming continues
          setLastApiQuery('');
          setGraphVersion((v) => v + 1);
          onGraphLoadedRef.current?.();
          setStats(stats);

          // 2) Stream the leaf types in pages. Accumulate pages into a pending
          // buffer and flush to React state in a few LARGE batches (not per
          // page), so the renderer rebuilds a handful of times rather than once
          // per page — the key to not regressing huge graphs.
          const cap = readMaxVisNodes();
          const skelSet = new Set(skeletonTypes);
          const leafTypes = Object.keys(byType)
            .filter((t) => (byType[t] ?? 0) > 0 && !skelSet.has(t))
            .sort((a, b) => leafRank(a) - leafRank(b));
          const seenLinks = new Set<string>(skel.links.map(linkKey));
          let loaded = skel.nodes.length;

          let pendNodes: GraphNode[] = [];
          let pendLinks: GraphLink[] = [];
          let lastFlush = performance.now();
          const flush = () => {
            if (!pendNodes.length && !pendLinks.length) return;
            const ns = pendNodes;
            const ls = pendLinks;
            pendNodes = [];
            pendLinks = [];
            setGraphData((prev) => ({
              nodes: ns.length ? prev.nodes.concat(ns) : prev.nodes,
              links: ls.length ? prev.links.concat(ls) : prev.links,
            }));
            lastFlush = performance.now();
          };

          let reachedCap = false;
          for (const type of leafTypes) {
            if (reachedCap) break;
            let offset = 0;
            for (;;) {
              if (loadSeq !== loadSeqRef.current) return; // superseded
              if (loaded >= cap) {
                reachedCap = true;
                break;
              }
              const limit = Math.min(STREAM_BATCH, cap - loaded);
              const page = await store.fetchGraphPage!({ type, offset, limit });
              if (loadSeq !== loadSeqRef.current) return;

              for (const l of page.links) {
                const k = linkKey(l);
                if (!seenLinks.has(k)) {
                  seenLinks.add(k);
                  pendLinks.push(l);
                }
              }
              loaded += page.nodes.length;
              if (page.nodes.length) pendNodes.push(...page.nodes);

              if (
                pendNodes.length >= FLUSH_NODES ||
                performance.now() - lastFlush >= FLUSH_MS
              ) {
                flush();
              }
              offset += limit;
              if (page.exhausted) break;
              await new Promise((r) => setTimeout(r, STREAM_YIELD_MS));
            }
          }
          flush(); // final remainder
        } catch (err) {
          onErr(err as { name?: string; message: string });
        }
      }
    },
    [store],
  );

  useEffect(() => {
    loadGraphRef.current = loadGraph;
  }, [loadGraph]);

  useEffect(() => {
    // Only fetch on mount if the DB has been initialized (i.e. data has been
    // imported before). Skip the initial fetch for fresh sessions — this avoids
    // triggering WASM worker init (8+ seconds) before the user adds a repo.
    if (store.hasData()) {
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

  // Clear any pending live-flush timer on unmount.
  useEffect(
    () => () => {
      if (liveFlushTimer.current) clearTimeout(liveFlushTimer.current);
    },
    [],
  );

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
      isStreaming,
      startLiveStream,
      pushLiveBatch,
      endLiveStream,
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
      isStreaming,
      startLiveStream,
      pushLiveBatch,
      endLiveStream,
    ],
  );
}
