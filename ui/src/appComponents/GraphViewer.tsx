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
  PixiGraphCanvas,
  detectProvider,
  normalizeRepoUrl,
  type IndexingState,
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
import { useGraphInteraction } from '../providers/GraphInteractionProvider';
import { getSubType } from '../providers/graphFilterUtils';
import type { JobMessage, JobState } from '../job';
import { JobPhase } from '../job';
import { useStore } from '../store';
import { useGraphViewer } from '../hooks/useGraphViewer';
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

      const v = useGraphViewer({
        chatHighlightNodes,
        suppressNextAutoFitRef: suppressNextFitRef,
      });

      const {
        graphData,
        loading,
        error,
        lastSearchQuery,
        loadGraph,
        setError,
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

      const pendingMinimize = useRef(false);
      const minimizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
      );

      // React to persisted: load the graph, then auto-minimize after a brief delay
      useEffect(() => {
        if (jobState.status === 'persisted') {
          loadGraph()
            .then(() => {
              pendingMinimize.current = true;
            })
            .catch(() => {
              // Graph load failed — don't set pendingMinimize
            });
        }
      }, [jobState.status, loadGraph]);

      // React to done: final graph refresh with enriched data. Suppress the
      // auto-fit this reload would otherwise trigger — embeddings only add
      // vector properties to existing nodes, so the view should not re-animate.
      useEffect(() => {
        if (jobState.status === 'done') {
          suppressNextFitRef.current = true;
          loadGraph().finally(() => {
            // Defensive reset: if loadGraph failed or was aborted, the
            // graphVersion-driven auto-fit never fired and the flag would
            // leak onto the next unrelated call.
            suppressNextFitRef.current = false;
          });
        }
      }, [jobState.status, loadGraph]);

      // Expose imperative handle for parent/sibling access
      useImperativeHandle(ref, () => v.buildImperativeHandle(), [v]);

      // Determine whether to show the full indexing progress modal
      const showFullModal =
        jobState.status === 'running' ||
        jobState.status === 'persisted' ||
        jobState.status === 'error' ||
        ((jobState.status === 'enriching' || jobState.status === 'done') &&
          (jobExpanded || (loading && v.isEmpty)));

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

      if (loading && v.isEmpty && !showAddRepo && !showFullModal) {
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

      if (v.isEmpty && !showFullModal) {
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
                onJobExpand={onJobExpand}
                onJobCancel={onJobCancel}
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
            />
          )}

          <GraphLegend items={v.legendItems} linkItems={v.legendLinkItems} />

          <PixiGraphCanvas
            ref={v.canvasRef}
            nodes={graphData.nodes}
            links={graphData.links}
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
            labelsVisible={v.settings.labelsVisible}
            layoutMode={v.settings.layoutMode}
            mode3d={v.settings.mode3d}
            on3DAutoRotateChange={v.settings.setRendererAutoRotate}
            animationSettings={animationSettings}
            style={{ isolation: 'isolate' }}
          />

          {showPhysicsPanel && (
            <PhysicsPanelContainer
              canvasRef={v.canvasRef}
              repulsion={v.settings.repulsion}
              setRepulsion={v.settings.setRepulsion}
              labelsVisible={v.settings.labelsVisible}
              setLabelsVisible={v.settings.setLabelsVisible}
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
            />
          )}

          <GraphControlsBar
            canvasRef={v.canvasRef}
            graphFullscreen={graphFullscreen}
            onToggleGraphFullscreen={onToggleGraphFullscreen}
            zoomOnSelect={v.settings.zoomOnSelect}
            setZoomOnSelect={v.settings.setZoomOnSelect}
            showPhysicsPanel={showPhysicsPanel}
            setShowPhysicsPanel={setShowPhysicsPanel}
            layoutMode={v.settings.layoutMode}
            setLayoutMode={v.settings.setLayoutMode}
            mode3d={v.settings.mode3d}
            setMode3d={v.settings.setMode3d}
          />
        </div>
      );
    },
  ),
);

export default GraphViewer;
