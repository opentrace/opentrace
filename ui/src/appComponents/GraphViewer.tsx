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

import {
  AddRepoModal,
  GraphLegend,
  GraphToolbar,
  IndexingProgress,
  ThreeGraphCanvas,
  detectProvider,
  normalizeRepoUrl,
  GRAPH_PRESETS,
  DEFAULT_PRESET_ID,
  CUSTOM_PRESET,
  getPreset,
  type IndexingState,
  type GraphPresetSettings,
} from '@opentrace/components';
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useGraph } from '../providers/GraphDataProvider';
import { PROGRESSIVE_LOAD_ENABLED } from '../hooks/useGraphData';
import { useGraphInteraction } from '../providers/GraphInteractionProvider';
import { getSubType } from '../providers/graphFilterUtils';
import type { JobMessage, JobState } from '../job';
import { JobPhase } from '../job';
import { useStore } from '../store';
import {
  useGraphViewer,
  GRAPH_SETTING_DEFAULTS,
} from '../hooks/useGraphViewer';
import type { GraphViewerImperativeHandle } from '../hooks/useGraphViewer';
import ExportModal from './ExportModal';
import {
  EmptyStateHeader,
  GraphErrorState,
  GraphInitialEmpty,
  GraphLoadingState,
  GraphSearchEmpty,
} from './GraphEmptyStates';
import { GraphControlsBar } from './GraphControlsBar';
import {
  GitHubStarButton,
  GraphToolbarActionButtons,
  buildMobilePanelTabs,
} from './GraphToolbarActions';
import { PhysicsPanelContainer } from './PhysicsPanelContainer';
import { GitHubIcon, GitLabIcon } from './providerIcons';
import LiveIndexingPanel from './LiveIndexingPanel';
import ViewPresetBar from './ViewPresetBar';
import NodeHoverCard, { type HoverInfo } from './NodeHoverCard';
import type { GraphNode } from '../components/graph/types';
import ResetConfirmModal from './ResetConfirmModal';
import type { SidePanelTab } from './SidePanel';

const INDEXING_STAGES = [
  { key: String(JobPhase.JOB_PHASE_INITIALIZING), label: 'Initializing' },
  { key: String(JobPhase.JOB_PHASE_FETCHING), label: 'Fetching files' },
  { key: String(JobPhase.JOB_PHASE_PARSING), label: 'Files & symbols' },
  { key: String(JobPhase.JOB_PHASE_RESOLVING), label: 'Call resolution' },
  { key: String(JobPhase.JOB_PHASE_SUMMARIZING), label: 'Summarizing' },
  { key: String(JobPhase.JOB_PHASE_SUBMITTING), label: 'Persisting graph' },
  { key: String(JobPhase.JOB_PHASE_EMBEDDING), label: 'Generating embeddings' },
];

/** The Three.js renderer (real 3D + 100k-node headroom) is the sole graph
 *  canvas; the legacy Pixi renderer has been removed. */
const GraphCanvasImpl = ThreeGraphCanvas;

/** localStorage key for the last-applied view preset id (or 'custom'). */
const PRESET_STORAGE_KEY = 'ot-active-preset';

/** Map app-specific JobState to the generic IndexingState + title/message. */
function toIndexingProps(job: JobState, repoUrl: string) {
  let status: IndexingState['status'];
  let title: string | undefined;
  let message: string | undefined;

  switch (job.status) {
    case 'persisted':
      status = 'done';
      title = 'Indexing Complete';
      message = 'Loading graph...';
      break;
    case 'enriching':
      status = 'running';
      title = 'Enriching Repository';
      break;
    default:
      status = job.status;
  }

  const state: IndexingState = {
    status,
    nodesCreated: job.nodesCreated,
    relationshipsCreated: job.relationshipsCreated,
    error: job.error,
    stages: job.stages as Record<string, IndexingState['stages'][string]>,
  };

  const provider = detectProvider(repoUrl);
  const icon =
    provider === 'gitlab' ? <GitLabIcon /> : provider ? <GitHubIcon /> : null;

  return { state, title, message, icon };
}

export type GraphViewerHandle = GraphViewerImperativeHandle;

export interface GraphViewerProps {
  width: number;
  height: number;
  // Job (App owns state, GraphViewer renders UI)
  jobState: JobState;
  activeRepoUrl: string;
  jobExpanded: boolean;
  onJobClose: () => void;
  onJobCancel: () => void;
  onJobMinimize: () => void;
  onJobExpand: () => void;
  // Add repo modal
  showAddRepo: boolean;
  onAddRepoOpen: () => void;
  onAddRepoClose: () => void;
  onJobSubmit: (message: JobMessage) => void;
  // Toolbar toggles
  showChat: boolean;
  chatWidth: number;
  onToggleChat: () => void;
  showSettings: boolean;
  onToggleSettings: () => void;
  showHelp: boolean;
  onToggleHelp: () => void;
  /** Node IDs found by chat tool results — highlighted when no other selection is active */
  chatHighlightNodes?: Set<string>;
  /** Animation settings from SettingsDrawer */
  animationSettings?: import('@opentrace/components').AnimationSettings;
  /** Additional React elements rendered in the toolbar's actions area (right side).
   *  Appended after the built-in buttons (chat toggle, settings, theme). */
  toolbarActions?: React.ReactNode;
  /** Mobile: whether the graph is in fullscreen mode (hides chat) */
  graphFullscreen?: boolean;
  /** Mobile: toggle graph fullscreen */
  onToggleGraphFullscreen?: () => void;
  /** Mobile: open SidePanel on a given tab (state lives in App). */
  onMobilePanelTabChange?: (tab: SidePanelTab) => void;
}

const GraphViewer = memo(
  forwardRef<GraphViewerHandle, GraphViewerProps>(
    function GraphViewer(props, ref) {
      const {
        width,
        height,
        jobState,
        activeRepoUrl,
        jobExpanded,
        onJobClose,
        onJobCancel,
        onJobMinimize,
        onJobExpand,
        showAddRepo,
        onAddRepoOpen,
        onAddRepoClose,
        onJobSubmit,
        showChat,
        chatWidth,
        onToggleChat,
        showSettings,
        onToggleSettings,
        showHelp,
        onToggleHelp,
        chatHighlightNodes,
        animationSettings,
        toolbarActions,
        graphFullscreen,
        onToggleGraphFullscreen,
        onMobilePanelTabChange,
      } = props;

      const { store } = useStore();

      // Set by the post-embedding reload effect to suppress the redundant
      // auto-fit it would otherwise trigger (embeddings only add vector
      // properties to existing nodes — the structural graph is unchanged).
      //
      // Known limitation: if the `persisted` loadGraph is still in-flight
      // when `done` fires (tiny repos with near-instant embedding + slow
      // fetchGraph), the wrong increment may consume the flag. The window
      // is small in practice — embedding typically dominates `fetchGraph`
      // by orders of magnitude — so we accept the race rather than thread
      // per-promise suppression tokens through useGraph.
      const suppressNextFitRef = useRef(false);

      // True once a live-build has run for the current job — the graph built
      // itself during indexing, so the post-index build burst is suppressed
      // (it would re-collapse + re-burst = "starting over").
      const liveGrewRef = useRef(false);

      const v = useGraphViewer({
        chatHighlightNodes,
        suppressNextAutoFitRef: suppressNextFitRef,
      });

      // Already-scaled compact-layout config for the canvas. Memoized so the
      // canvas's "apply on load / change" effect only fires when a value
      // actually changes (a fresh object every render would re-run it).
      const compactConfigProp = useMemo(
        () => ({
          radialStrength: v.settings.compactRadial / 100,
          communityPull: v.settings.compactCommunity / 100,
          centeringStrength: v.settings.compactCentering / 100,
          radiusScale: v.settings.compactRadius,
        }),
        [
          v.settings.compactRadial,
          v.settings.compactCommunity,
          v.settings.compactCentering,
          v.settings.compactRadius,
        ],
      );

      const {
        graphData,
        graphVersion,
        loading,
        error,
        refreshError,
        lastSearchQuery,
        loadGraph,
        setError,
        setRefreshError,
        isStreaming,
      } = useGraph();

      const {
        selectedNode,
        hiddenNodeTypes,
        hiddenLinkTypes,
        hiddenSubTypes,
        hiddenCommunities,
        colorMode,
        setColorMode,
        availableSubTypes,
        communityData,
      } = useGraphInteraction();

      // ── View presets ───────────────────────────────────────────────
      const [activePresetId, setActivePresetId] = useState<string | null>(
        () => {
          try {
            return localStorage.getItem(PRESET_STORAGE_KEY);
          } catch {
            return null;
          }
        },
      );

      // ── Node hover tooltip (renderer reports enter/leave; the card itself
      //    applies the show delay + lazy summary fetch) ─────────────────
      const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
      const onNodeHover = useCallback(
        (node: GraphNode | null, x: number, y: number) => {
          setHoverInfo(node ? { node, x, y } : null);
        },
        [],
      );

      /** Apply a preset's full settings to React state + the renderer. Mirrors
       *  the reset handler's imperative push (prop effects only fire on a
       *  *change*, so we also call the canvas API directly). `animate` reheats
       *  + recenters for a live switch; skipped on first-load so it doesn't
       *  fight the initial layout / build animation. */
      const applyPresetSettings = useCallback(
        (s: GraphPresetSettings, animate: boolean) => {
          const set = v.settings;
          // 1. React state — drives canvas props + persistence effects.
          set.setLayoutMode(s.layoutMode);
          set.setMode3d(s.mode3d);
          set.setRendererAutoRotate(s.autoRotate);
          setColorMode(s.colorMode);
          set.setCommunitiesEnabled(s.communitiesEnabled);
          set.setCommunityLabelsVisible(s.communityLabelsVisible);
          set.setRepulsion(s.repulsion);
          set.setPixiLinkDist(s.linkDistance);
          set.setPixiCenter(s.centerStrength);
          set.setCompactRadial(s.compactRadial);
          set.setCompactCommunity(s.compactCommunity);
          set.setCompactCentering(s.compactCentering);
          set.setCompactRadius(s.compactRadius);
          set.setEdgeOpacity(s.edgeOpacity);
          set.setPixiZoomExponent(s.zoomSizeExponent);
          set.setLabelScale(s.labelScale);
          set.setMode3dSpeed(s.mode3dSpeed);
          set.setMode3dTilt(s.mode3dTilt);
          set.setLabelsVisible(s.labelsVisible);
          set.setEdgesVisible(s.edgesVisible);
          // 2. Push to the renderer imperatively.
          const c = v.canvasRef.current;
          c?.setLayoutMode?.(s.layoutMode);
          c?.set3DMode?.(s.mode3d);
          c?.set3DAutoRotate?.(s.autoRotate);
          c?.set3DSpeed?.(s.mode3dSpeed / 10000);
          c?.set3DTilt?.(s.mode3dTilt / 100);
          c?.setChargeStrength?.(-s.repulsion);
          c?.setLinkDistance?.(s.linkDistance);
          c?.setCenterStrength?.(s.centerStrength);
          c?.updateCompactConfig?.({
            radialStrength: s.compactRadial / 100,
            communityPull: s.compactCommunity / 100,
            centeringStrength: s.compactCentering / 100,
            radiusScale: s.compactRadius,
          });
          c?.setEdgeOpacity?.(s.edgeOpacity / 100);
          c?.setZoomSizeExponent?.(s.zoomSizeExponent);
          c?.setLabelScale?.(s.labelScale / 100);
          c?.setShowLabels?.(s.labelsVisible);
          c?.setEdgesEnabled?.(s.edgesVisible);
          c?.setShowCommunityLabels?.(s.communityLabelsVisible);
          // 3. Nebula is a worker-internal layout toggled separately;
          //    enabling it seeds + restarts the sim itself.
          c?.setNebulaLayout?.(s.nebula, s.layoutMode);
          // 4. On a live switch, re-lay-out from a fresh seed so the result is
          //    independent of the layout that was on screen — otherwise the
          //    previous preset's shape bleeds into the new one. The nebula does
          //    its own seeding, so skip reseed there. Skipped on first-load (the
          //    graph is already laying out fresh) and during a build animation.
          if (animate && !c?.isBuildAnimating?.()) {
            if (!s.nebula) {
              if (c?.reseedLayout) c.reseedLayout();
              else c?.reheat?.();
            }
            if (c?.scheduleAutoFit) c.scheduleAutoFit(800);
            else c?.zoomToFit?.(800);
          }
        },
        [v.settings, v.canvasRef, setColorMode],
      );

      /** Apply a preset by id and remember the choice. */
      const handleSelectPreset = useCallback(
        (id: string) => {
          const preset = getPreset(id);
          if (!preset) return;
          setActivePresetId(id);
          try {
            localStorage.setItem(PRESET_STORAGE_KEY, id);
          } catch {
            // ignore
          }
          applyPresetSettings(preset.settings, true);
        },
        [applyPresetSettings],
      );

      /** Drop the active-preset highlight when the user hand-tweaks a control —
       *  the look no longer matches a named preset. */
      const handleUserAdjust = useCallback(() => {
        setActivePresetId((prev) => {
          if (prev === CUSTOM_PRESET) return prev;
          try {
            localStorage.setItem(PRESET_STORAGE_KEY, CUSTOM_PRESET);
          } catch {
            // ignore
          }
          return CUSTOM_PRESET;
        });
      }, []);

      // On the first graph load, restore the remembered preset (re-applied in
      // full so options that don't persist — autorotate, color mode — are
      // honored), or apply the default on a user's very first load. Runs once
      // per mount; 'custom' means the user is hand-driving, so we leave the
      // individually-persisted settings alone.
      const presetAppliedRef = useRef(false);
      useEffect(() => {
        if (presetAppliedRef.current) return;
        if (graphVersion === 0 || graphData.nodes.length === 0) return;
        presetAppliedRef.current = true;
        let stored: string | null = null;
        try {
          stored = localStorage.getItem(PRESET_STORAGE_KEY);
        } catch {
          // ignore
        }
        if (stored === CUSTOM_PRESET) return;
        const id = stored ?? DEFAULT_PRESET_ID;
        const preset = getPreset(id);
        if (!preset) return;
        setActivePresetId(id);
        if (stored === null) {
          try {
            localStorage.setItem(PRESET_STORAGE_KEY, id);
          } catch {
            // ignore
          }
        }
        applyPresetSettings(preset.settings, false);
      }, [graphVersion, graphData.nodes.length, applyPresetSettings]);

      // Sync ambient motion (gentle perpetual drift) to the renderer. Re-applied
      // on each graph load (graphVersion) since a fresh layout resets the worker.
      useEffect(() => {
        v.canvasRef.current?.setAmbientMotion?.(v.settings.ambientMotion);
      }, [v.canvasRef, v.settings.ambientMotion, graphVersion]);

      // Auto fit-to-screen whenever a setting changes the graph's layout or
      // extent, so the user never has to manually reframe after a tweak.
      // Debounced so a slider drag fits once on release (after the layout has
      // begun reacting). Visual-only settings (colors) are intentionally not
      // included — they don't move the graph.
      const s = v.settings;
      const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const firstFitSyncRef = useRef(true);
      useEffect(() => {
        if (graphVersion === 0) return;
        // Skip the initial mount — the graphVersion auto-fit already frames the
        // first load; this effect only fits on subsequent setting changes.
        if (firstFitSyncRef.current) {
          firstFitSyncRef.current = false;
          return;
        }
        if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
        fitTimerRef.current = setTimeout(() => {
          v.canvasRef.current?.fitToScreen?.();
        }, 450);
        return () => {
          if (fitTimerRef.current) clearTimeout(fitTimerRef.current);
        };
      }, [
        v.canvasRef,
        graphVersion,
        s.repulsion,
        s.pixiLinkDist,
        s.pixiCenter,
        s.pixiZoomExponent,
        s.layoutMode,
        s.compactRadial,
        s.compactCommunity,
        s.compactCentering,
        s.compactRadius,
        s.mode3d,
        s.mode3dTilt,
        s.labelsVisible,
        s.edgesVisible,
        s.communityLabelsVisible,
        s.ambientMotion,
      ]);

      // Fetch indexed repos when the add-repo modal opens (for duplicate detection)
      interface IndexedRepo {
        name: string;
        url: string;
      }
      const [indexedRepos, setIndexedRepos] = useState<IndexedRepo[]>([]);
      useEffect(() => {
        if (!showAddRepo) return;
        let cancelled = false;
        store
          .listNodes('Repository')
          .then((nodes) => {
            if (cancelled) return;
            setIndexedRepos(
              nodes
                .filter((n) => n.properties?.sourceUri || n.properties?.url)
                .map((n) => ({
                  name: n.name,
                  url: (n.properties!.sourceUri ?? n.properties!.url) as string,
                })),
            );
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [showAddRepo, store]);

      const validateRepo = useCallback(
        (url: string): string | null => {
          if (indexedRepos.length === 0) return null;
          const normalized = normalizeRepoUrl(url).toLowerCase();
          const match = indexedRepos.find(
            (r) => normalizeRepoUrl(r.url).toLowerCase() === normalized,
          );
          return match ? `${match.name} is already indexed` : null;
        },
        [indexedRepos],
      );

      const [showResetConfirm, setShowResetConfirm] = useState(false);
      const [showExportModal, setShowExportModal] = useState(false);
      const [exporting, setExporting] = useState(false);
      const [showPhysicsPanel, setShowPhysicsPanel] = useState(false);
      const physicsTriggerRef = useRef<HTMLButtonElement>(null);

      // Close the physics panel on a pointerdown outside the panel and
      // outside its trigger button (Fix #21). The trigger handles its
      // own toggle, so we skip it here to avoid double-toggling — the
      // existing `onClick` would re-open immediately otherwise.
      useEffect(() => {
        if (!showPhysicsPanel) return;
        const onPointerDown = (e: PointerEvent) => {
          const target = e.target as Element | null;
          if (!target) return;
          if (target.closest('.physics-panel')) return;
          if (
            physicsTriggerRef.current &&
            physicsTriggerRef.current.contains(target)
          )
            return;
          setShowPhysicsPanel(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [showPhysicsPanel]);

      const pendingMinimize = useRef(false);
      const minimizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
      );

      // Track whether the current job built live (drives build-burst suppression
      // below). The actual begin/end is driven by the canvas `liveGrow` prop.
      useEffect(() => {
        if (isStreaming) liveGrewRef.current = true;
        else if (jobState.status === 'idle') liveGrewRef.current = false;
      }, [isStreaming, jobState.status]);

      // React to persisted: load the graph, then auto-minimize after a brief delay
      useEffect(() => {
        if (jobState.status === 'persisted') {
          // Arm the build animation NOW, before the indexed graph reaches the
          // canvas. The renderer collapses it the instant it's built (before
          // first paint), holds it hidden, and AUTO-PLAYS itself once the
          // layout settles — so there's no flash and no fragile external timer
          // that could fire before the collapse on a slow-to-lay-out graph
          // (which previously left it stuck hidden until manual replay).
          // Suppressed during progressive
          // streaming: the burst would play on the skeleton, then the rest
          // streams in + the 3D layout develops, reading as a 2D plane
          // expanding to 3D. (Proper streaming+burst integration is deferred.)
          // A live-built graph is already on screen — skip both the
          // build-animation burst AND the loadGraph here, either of which
          // would reshuffle / "start over". endLiveStream already bumped the
          // version + loaded stats, and itself reloads from the store in the
          // cases where the live graph is NOT authoritative (the store held
          // other repos before this job, cancel, recoverable error).
          if (liveGrewRef.current) {
            pendingMinimize.current = true;
            return;
          }
          if (!PROGRESSIVE_LOAD_ENABLED) {
            v.canvasRef.current?.armBuildAnimation?.();
          }
          loadGraph()
            .then(() => {
              pendingMinimize.current = true;
            })
            .catch(() => {
              // Graph load failed — don't set pendingMinimize
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [jobState.status, loadGraph]);

      // React to done: final graph refresh with enriched data. Suppress the
      // auto-fit this reload would otherwise trigger — embeddings only add
      // vector properties to existing nodes, so the view should not re-animate.
      useEffect(() => {
        if (jobState.status === 'done') {
          // Skip for live-built graphs — reloading would replace the graph the
          // user watched build and reshuffle it. (Enrichment only adds vector
          // properties used by search, not the on-screen structure.)
          if (liveGrewRef.current) return;
          suppressNextFitRef.current = true;
          // The flag is consumed (read-and-reset) by the graphVersion-driven
          // auto-fit effect in useGraphViewer AFTER React commits the reload.
          // Do NOT clear it in a `.finally` here: that runs in a microtask,
          // before the commit, so the effect would still see the flag as
          // false and auto-fit anyway (making the suppression dead code).
          loadGraph().catch(() => {
            // Load failed — no graphVersion bump, so the consumer never
            // reads the flag. Reset it here so it can't leak onto the next
            // unrelated load.
            suppressNextFitRef.current = false;
          });
        }
      }, [jobState.status, loadGraph]);

      // Expose imperative handle for parent/sibling access
      useImperativeHandle(ref, () => v.buildImperativeHandle(), [v]);

      // A browser index job is actively producing the graph. While active, the
      // compact LiveIndexingPanel (bottom-left) is the default surface and the
      // graph builds live behind it — the full-screen modal is opt-in.
      const jobActive =
        jobState.status === 'running' ||
        jobState.status === 'persisted' ||
        jobState.status === 'enriching';

      // The full-screen indexing modal is now opt-in: it shows only when the
      // user explicitly expands the live panel, or on error (which needs the
      // detailed failure view). Everything else stays in the live panel so the
      // graph remains visible building in front of the user.
      const showFullModal = jobExpanded || jobState.status === 'error';

      // The compact live panel owns the running / building / enriching states
      // whenever the user hasn't expanded to the full modal.
      const showLivePanel = jobActive && !jobExpanded;

      const graphWidth = showChat || showHelp ? width - chatWidth : width;

      // Auto-minimize once graph data has arrived (bridges "Loading graph..." modal
      // to the "Computing layout" overlay without flashing "no data").
      useEffect(() => {
        if (pendingMinimize.current && !v.isEmpty) {
          pendingMinimize.current = false;
          minimizeTimeoutRef.current = setTimeout(() => {
            minimizeTimeoutRef.current = null;
            onJobMinimize();
          }, 500);
        }
        return () => {
          if (minimizeTimeoutRef.current) {
            clearTimeout(minimizeTimeoutRef.current);
            minimizeTimeoutRef.current = null;
          }
        };
      }, [v.isEmpty, onJobMinimize]);

      // Auto-open the Add Repo modal when the graph is empty and idle
      useEffect(() => {
        if (
          v.isEmpty &&
          !v.isSearchEmpty &&
          !loading &&
          jobState.status === 'idle'
        ) {
          onAddRepoOpen();
        }
      }, [v.isEmpty, v.isSearchEmpty, loading, jobState.status, onAddRepoOpen]);

      const persistentActions = useMemo(() => <GitHubStarButton />, []);

      // --- Early returns for loading/error/empty states ---

      if (
        loading &&
        v.isEmpty &&
        !showAddRepo &&
        !showFullModal &&
        !jobActive
      ) {
        return <GraphLoadingState />;
      }

      if (error) {
        return (
          <GraphErrorState
            error={error}
            onRetry={() => {
              setError(null);
              loadGraph();
            }}
          />
        );
      }

      if (v.isSearchEmpty && !showFullModal) {
        return (
          <GraphSearchEmpty
            searchQuery={lastSearchQuery}
            onClearSearch={v.toolbar.onReset}
          />
        );
      }

      if (v.isEmpty && !showFullModal && !jobActive) {
        return (
          <GraphInitialEmpty
            showAddRepo={showAddRepo}
            showFullModal={showFullModal}
            onAddRepoOpen={onAddRepoOpen}
            onAddRepoClose={onAddRepoClose}
            onJobSubmit={onJobSubmit}
            onValidateRepo={validateRepo}
            indexingProgress={
              <IndexingProgress
                {...toIndexingProps(jobState, activeRepoUrl)}
                stages={INDEXING_STAGES}
                onClose={onJobClose}
                onMinimize={onJobMinimize}
              />
            }
          />
        );
      }

      // --- Main graph viewport ---

      return (
        <div className="graph-viewport">
          <GraphToolbar
            logo={
              <button
                type="button"
                className="header-logo header-logo--clickable"
                onClick={() => setShowResetConfirm(true)}
              >
                <img src="/opentrace-logo.svg" alt="OpenTrace" />
                <h1>OpenTrace</h1>
              </button>
            }
            searchQuery={v.toolbar.searchQuery}
            onSearchQueryChange={v.toolbar.onSearchQueryChange}
            onSearch={v.toolbar.onSearch}
            onReset={v.toolbar.onReset}
            searchDisabled={v.toolbar.searchDisabled}
            showResetButton={v.toolbar.showResetButton}
            searchSuggestions={v.toolbar.searchSuggestions}
            onSuggestionSelect={v.toolbar.onSuggestionSelect}
            hops={v.toolbar.hops}
            onHopsChange={v.toolbar.onHopsChange}
            nodeCount={v.toolbar.nodeCount}
            edgeCount={v.toolbar.edgeCount}
            totalNodes={v.toolbar.totalNodes}
            totalEdges={v.toolbar.totalEdges}
            mobilePanelTabs={buildMobilePanelTabs({
              showDetails: v.toolbar.showDetailsTab,
            })}
            onMobilePanelTab={(key) =>
              onMobilePanelTabChange?.(key as SidePanelTab)
            }
            persistentActions={persistentActions}
            actions={
              <GraphToolbarActionButtons
                toolbarActions={toolbarActions}
                jobState={jobState}
                jobExpanded={jobExpanded}
                onAddRepoOpen={onAddRepoOpen}
                hasGraphData={graphData.nodes.length > 0}
                canExport={!!store.exportDatabase}
                exporting={exporting}
                onExportOpen={() => {
                  if (!store.exportDatabase || exporting) return;
                  setShowExportModal(true);
                }}
                showChat={showChat}
                onToggleChat={onToggleChat}
                showHelp={showHelp}
                onToggleHelp={onToggleHelp}
                showSettings={showSettings}
                onToggleSettings={onToggleSettings}
              />
            }
          />

          {showResetConfirm && (
            <ResetConfirmModal
              onConfirm={() => window.location.reload()}
              onCancel={() => setShowResetConfirm(false)}
            />
          )}

          {showExportModal && store.exportDatabase && (
            <ExportModal
              onCancel={() => setShowExportModal(false)}
              onExport={async ({ includeSource, repoId }) => {
                setShowExportModal(false);
                setExporting(true);
                try {
                  const data = await store.exportDatabase!({
                    includeSource,
                    repoId,
                  });
                  const buf = new Uint8Array(data).buffer as ArrayBuffer;
                  const blob = new Blob([buf], {
                    type: 'application/octet-stream',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  const safeName = repoId
                    ? repoId.replace(/\//g, '-')
                    : 'opentrace';
                  a.download = `${safeName}.parquet.zip`;
                  a.click();
                  URL.revokeObjectURL(url);
                } finally {
                  setExporting(false);
                }
              }}
            />
          )}

          {showAddRepo && jobState.status === 'idle' && (
            <AddRepoModal
              onClose={onAddRepoClose}
              onSubmit={onJobSubmit}
              onValidate={validateRepo}
            />
          )}

          {v.isEmpty && showFullModal && <EmptyStateHeader />}

          {showFullModal && (
            <IndexingProgress
              {...toIndexingProps(jobState, activeRepoUrl)}
              stages={INDEXING_STAGES}
              onClose={onJobClose}
              onMinimize={
                jobState.status === 'running' ||
                jobState.status === 'enriching' ||
                jobState.status === 'persisted'
                  ? onJobMinimize
                  : undefined
              }
            />
          )}

          {showLivePanel && (
            <LiveIndexingPanel
              state={jobState}
              stages={INDEXING_STAGES}
              icon={toIndexingProps(jobState, activeRepoUrl).icon}
              onExpand={onJobExpand}
              onCancel={onJobCancel}
            />
          )}

          {/* While fetching/parsing there's no graph yet — show a calm centered
              loader (not a black void). The build animation reveals the real
              graph the moment it's ready. */}
          {jobActive && v.isEmpty && (
            <div className="graph-build-loader" aria-hidden>
              <span className="graph-build-loader__spinner" />
            </div>
          )}

          <GraphLegend items={v.legendItems} linkItems={v.legendLinkItems} />

          {refreshError && (
            <div className="refresh-error-banner" role="alert">
              <span className="refresh-error-banner__text">
                Refresh failed: {refreshError}
              </span>
              <button
                type="button"
                className="refresh-error-banner__retry"
                onClick={() => loadGraph()}
              >
                Retry
              </button>
              <button
                type="button"
                className="refresh-error-banner__dismiss"
                aria-label="Dismiss"
                onClick={() => setRefreshError(null)}
              >
                ×
              </button>
            </div>
          )}

          <GraphCanvasImpl
            ref={v.canvasRef}
            nodes={graphData.nodes}
            links={graphData.links}
            liveGrow={isStreaming}
            width={graphWidth}
            height={height}
            layoutConfig={v.layoutConfig}
            colorMode={colorMode}
            hiddenNodeTypes={hiddenNodeTypes}
            hiddenLinkTypes={hiddenLinkTypes}
            hiddenSubTypes={hiddenSubTypes}
            hiddenCommunities={hiddenCommunities}
            searchQuery={v.toolbar.searchQuery}
            selectedNodeId={selectedNode?.id}
            hops={v.toolbar.hops}
            getSubType={getSubType}
            highlightNodes={v.highlightProps.highlightNodes}
            highlightLinks={v.highlightProps.highlightLinks}
            labelNodes={v.highlightProps.labelNodes}
            availableSubTypes={availableSubTypes}
            zIndex
            communityData={communityData}
            onNodeClick={v.onNodeClick}
            onEdgeClick={v.onLinkClick}
            onStageClick={v.onStageClick}
            onNodeHover={onNodeHover}
            labelsVisible={v.settings.labelsVisible}
            edgesEnabled={v.settings.edgesVisible}
            communityLabelsVisible={v.settings.communityLabelsVisible}
            layoutMode={v.settings.layoutMode}
            zoomSizeExponent={v.settings.pixiZoomExponent}
            labelScale={v.settings.labelScale / 100}
            edgeOpacity={v.settings.edgeOpacity / 100}
            chargeStrength={-v.settings.repulsion}
            linkDistance={v.settings.pixiLinkDist}
            compactConfig={compactConfigProp}
            mode3d={v.settings.mode3d}
            rotationSpeed={v.settings.mode3dSpeed / 10000}
            cameraTilt={v.settings.mode3dTilt / 100}
            on3DAutoRotateChange={v.settings.setRendererAutoRotate}
            animationSettings={animationSettings}
            style={{ isolation: 'isolate' }}
          />

          {/* Hidden only when the graph strip is genuinely tiny (the
              bottom-anchored legend wraps upward there and collides with any
              top-anchored row). Above that, the bar rearranges itself instead:
              it measures the toolbar and hangs below it, goes icon-only at
              ≤900px, and wraps to a second line rather than underflowing. */}
          {height >= 220 && (
            <ViewPresetBar
              presets={GRAPH_PRESETS}
              activePresetId={activePresetId}
              onSelectPreset={handleSelectPreset}
            />
          )}

          <NodeHoverCard info={hoverInfo} />

          {/* Fetch-phase placeholder: a job is running but nothing has streamed
              into the canvas yet (initializing / fetching the archive), so the
              viewport would otherwise be a black void. */}
          {jobActive && graphData.nodes.length === 0 && (
            <div className="graph-fetching-overlay" aria-live="polite">
              <img
                src="/opentrace-logo.svg"
                alt=""
                className="graph-fetching-overlay__logo"
              />
              <span className="graph-fetching-overlay__text">
                {(() => {
                  const stages = jobState.stages as Record<
                    string,
                    { status: string }
                  >;
                  const active = INDEXING_STAGES.find(
                    (s) => stages[s.key]?.status === 'active',
                  );
                  return active ? `${active.label}…` : 'Preparing…';
                })()}
              </span>
            </div>
          )}

          {showPhysicsPanel && (
            <PhysicsPanelContainer
              canvasRef={v.canvasRef}
              onUserAdjust={handleUserAdjust}
              repulsion={v.settings.repulsion}
              setRepulsion={v.settings.setRepulsion}
              labelsVisible={v.settings.labelsVisible}
              setLabelsVisible={v.settings.setLabelsVisible}
              edgesVisible={v.settings.edgesVisible}
              setEdgesVisible={v.settings.setEdgesVisible}
              communityLabelsVisible={v.settings.communityLabelsVisible}
              setCommunityLabelsVisible={v.settings.setCommunityLabelsVisible}
              communitiesEnabled={v.settings.communitiesEnabled}
              setCommunitiesEnabled={v.settings.setCommunitiesEnabled}
              colorMode={colorMode}
              setColorMode={setColorMode}
              physicsRunning={v.settings.physicsRunning}
              setPhysicsRunning={v.settings.setPhysicsRunning}
              pixiLinkDist={v.settings.pixiLinkDist}
              setPixiLinkDist={v.settings.setPixiLinkDist}
              pixiCenter={v.settings.pixiCenter}
              setPixiCenter={v.settings.setPixiCenter}
              pixiZoomExponent={v.settings.pixiZoomExponent}
              setPixiZoomExponent={v.settings.setPixiZoomExponent}
              layoutMode={v.settings.layoutMode}
              setLayoutMode={v.settings.setLayoutMode}
              compactRadial={v.settings.compactRadial}
              setCompactRadial={v.settings.setCompactRadial}
              compactCommunity={v.settings.compactCommunity}
              setCompactCommunity={v.settings.setCompactCommunity}
              compactCentering={v.settings.compactCentering}
              setCompactCentering={v.settings.setCompactCentering}
              compactRadius={v.settings.compactRadius}
              setCompactRadius={v.settings.setCompactRadius}
              mode3d={v.settings.mode3d}
              setMode3d={v.settings.setMode3d}
              mode3dSpeed={v.settings.mode3dSpeed}
              setMode3dSpeed={v.settings.setMode3dSpeed}
              mode3dTilt={v.settings.mode3dTilt}
              setMode3dTilt={v.settings.setMode3dTilt}
              rendererAutoRotate={v.settings.rendererAutoRotate}
              setRendererAutoRotate={v.settings.setRendererAutoRotate}
              labelScale={v.settings.labelScale}
              setLabelScale={v.settings.setLabelScale}
              edgeOpacity={v.settings.edgeOpacity}
              setEdgeOpacity={v.settings.setEdgeOpacity}
              ambientMotion={v.settings.ambientMotion}
              setAmbientMotion={v.settings.setAmbientMotion}
            />
          )}

          <GraphControlsBar
            canvasRef={v.canvasRef}
            onReplayBuild={() => v.canvasRef.current?.playBuildAnimation?.()}
            graphFullscreen={graphFullscreen}
            onToggleGraphFullscreen={onToggleGraphFullscreen}
            zoomOnSelect={v.settings.zoomOnSelect}
            setZoomOnSelect={v.settings.setZoomOnSelect}
            showPhysicsPanel={showPhysicsPanel}
            setShowPhysicsPanel={setShowPhysicsPanel}
            physicsTriggerRef={physicsTriggerRef}
            layoutMode={v.settings.layoutMode}
            setLayoutMode={v.settings.setLayoutMode}
            mode3d={v.settings.mode3d}
            setMode3d={v.settings.setMode3d}
            onUserAdjust={handleUserAdjust}
            onResetGraph={() => {
              const D = GRAPH_SETTING_DEFAULTS;
              // 0. Drop the active-preset highlight — reset returns to the bare
              //    defaults, which aren't one of the named presets.
              setActivePresetId(null);
              try {
                localStorage.removeItem(PRESET_STORAGE_KEY);
              } catch {
                // ignore
              }
              // 1. Reset React state + clear localStorage.
              v.settings.resetSettings();
              // 2. Push EVERY setting to the renderer/layout-worker.
              //    We do this even for settings the canvas already re-syncs
              //    via prop-driven useEffects, because
              //    those effects only fire when the prop *changes*. If
              //    the React state already matched the default before
              //    reset (e.g. layoutMode was 'compact' and the new
              //    default is 'compact'), the effect wouldn't fire and
              //    the renderer would be left in a stale state.
              const c = v.canvasRef.current;
              c?.setChargeStrength?.(-D.repulsion);
              c?.setLinkDistance?.(D.pixiLinkDist);
              c?.setCenterStrength?.(D.pixiCenter);
              c?.setLayoutMode?.(D.layoutMode);
              c?.updateCompactConfig?.({
                radialStrength: D.compactRadial / 100,
                communityPull: D.compactCommunity / 100,
                centeringStrength: D.compactCentering / 100,
                radiusScale: D.compactRadius,
              });
              c?.setZoomSizeExponent?.(D.pixiZoomExponent);
              c?.setLabelScale?.(D.labelScale / 100);
              c?.setEdgeOpacity?.(D.edgeOpacity / 100);
              c?.set3DMode?.(D.mode3d);
              c?.set3DSpeed?.(D.mode3dSpeed / 10000);
              c?.set3DTilt?.(D.mode3dTilt / 100);
              c?.set3DAutoRotate?.(true);
              c?.setShowLabels?.(D.labelsVisible);
              c?.setEdgesEnabled?.(D.edgesVisible);
              c?.setShowCommunityLabels?.(D.communityLabelsVisible);
              // 3. Reheat physics + reset camera (the original behaviour).
              c?.reheat?.();
              c?.resetCamera?.();
            }}
          />
        </div>
      );
    },
  ),
);

export default GraphViewer;
