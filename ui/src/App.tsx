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
import { useJobService, useJobStream } from './job';
import type { JobMessage } from './job';
import GraphViewer from './appComponents/GraphViewer';
import type { GraphViewerHandle } from './appComponents/GraphViewer';
import ChatPanel from './appComponents/ChatPanel';
import SettingsDrawer from './appComponents/SettingsDrawer';
import type { GraphNode, GraphLink } from '@opentrace/components/utils';
import { loadAnimationSettings } from './config/animation';
import { normalizeRepoUrl, detectProvider } from '@opentrace/components';
import type { AnimationSettings } from '@opentrace/components';
import { useStore } from './store';
import './App.css';

const EMPTY_GRAPH: { nodes: GraphNode[]; links: GraphLink[] } = {
  nodes: [],
  links: [],
};

interface AppProps {
  version?: string;
  buildTime?: string;
  initialRepoUrl?: string;
}

function App({ version, buildTime, initialRepoUrl }: AppProps = {}) {
  const { store } = useStore();
  const jobService = useJobService();
  const {
    state: jobState,
    start: startJob,
    cancel: cancelJob,
    minimize: minimizeJob,
    reset: resetJob,
  } = useJobStream(jobService);

  const graphViewerRef = useRef<GraphViewerHandle>(null);
  const [chatGraphData, setChatGraphData] = useState(EMPTY_GRAPH);
  const [chatHighlightNodes, setChatHighlightNodes] = useState<Set<string>>(
    () => new Set(),
  );
  const hasRepoParam = useRef(
    new URLSearchParams(window.location.search).has('repo'),
  );

  const [showChat, setShowChat] = useState(true);
  const [chatWidth, setChatWidth] = useState(480);
  const [showSettings, setShowSettings] = useState(false);
  const [animationSettings, setAnimationSettings] = useState<AnimationSettings>(
    loadAnimationSettings,
  );
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [activeRepoUrl, setActiveRepoUrl] = useState('');
  const [jobExpanded, setJobExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDimensions({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleJobSubmit = useCallback(
    (message: JobMessage) => {
      if (message.type === 'index-repo') {
        setActiveRepoUrl(message.repoUrl);
      } else if (message.type === 'index-directory') {
        setActiveRepoUrl(`local/${message.name}`);
      } else if (message.type === 'import-file') {
        setActiveRepoUrl(`import/${message.name}`);
      }
      setShowAddRepo(false);
      setJobExpanded(false);
      startJob(message);
    },
    [startJob],
  );

  // Index or navigate to a repo by URL — shared by ?repo= param and postMessage
  const handleRepoDeepLink = useCallback(
    async (repoUrl: string) => {
      const normalized = normalizeRepoUrl(repoUrl);
      const repos = await store.listNodes('Repository');
      const existing = repos.find((r) => {
        const nodeUrl = r.properties?.url;
        return (
          typeof nodeUrl === 'string' &&
          normalizeRepoUrl(nodeUrl) === normalized
        );
      });

      if (existing) {
        setActiveRepoUrl(repoUrl);
        await graphViewerRef.current?.reload(existing.id, 2);
        setTimeout(() => graphViewerRef.current?.selectNode(existing.id), 100);
      } else {
        const provider = detectProvider(repoUrl);
        const token = provider
          ? (localStorage.getItem(`ot_${provider}_pat`) ?? undefined)
          : undefined;
        handleJobSubmit({
          type: 'index-repo',
          repoUrl,
          token,
        });
      }
    },
    [store, handleJobSubmit],
  );

  // Handle initial repository on load (from prop or ?repo= param)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const repoParam = initialRepoUrl || params.get('repo');
    if (!repoParam) {
      hasRepoParam.current = false;
      return;
    }

    // Clean URL only if repo came from params, and only remove the repo param
    if (!initialRepoUrl && params.has('repo')) {
      params.delete('repo');
      const search = params.toString();
      const url = window.location.pathname + (search ? `?${search}` : '');
      window.history.replaceState({}, '', url);
    }

    handleRepoDeepLink(repoParam).then(() => {
      hasRepoParam.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time mount effect
  }, []);

  // Listen for postMessage from the Chrome extension (reuses existing tab)
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'opentrace:index-repo') return;
      const repoUrl = event.data.repoUrl;
      if (typeof repoUrl === 'string' && repoUrl) {
        handleRepoDeepLink(repoUrl);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [handleRepoDeepLink]);

  const handleJobClose = useCallback(() => {
    resetJob();
    setJobExpanded(false);
  }, [resetJob]);

  const handleCancelJob = useCallback(() => {
    cancelJob();
    setJobExpanded(false);
  }, [cancelJob]);

  const handleJobMinimize = useCallback(() => {
    minimizeJob();
    setJobExpanded(false);
  }, [minimizeJob]);
  const handleJobExpand = useCallback(() => setJobExpanded(true), []);
  const handleAddRepoOpen = useCallback(() => {
    if (hasRepoParam.current) return; // suppress while deep link is being handled
    setShowAddRepo(true);
  }, []);
  const handleAddRepoClose = useCallback(() => setShowAddRepo(false), []);
  const handleToggleChat = useCallback(() => setShowChat((v) => !v), []);
  const handleChatWidthChange = useCallback((w: number) => setChatWidth(w), []);
  const handleToggleSettings = useCallback(
    () => setShowSettings((v) => !v),
    [],
  );

  return (
    <div className="app" ref={containerRef}>
      <div className="app-body">
        <GraphViewer
          ref={graphViewerRef}
          width={dimensions.width}
          height={dimensions.height}
          jobState={jobState}
          activeRepoUrl={activeRepoUrl}
          jobExpanded={jobExpanded}
          onJobClose={handleJobClose}
          onJobCancel={handleCancelJob}
          onJobMinimize={handleJobMinimize}
          onJobExpand={handleJobExpand}
          showAddRepo={showAddRepo}
          onAddRepoOpen={handleAddRepoOpen}
          onAddRepoClose={handleAddRepoClose}
          onJobSubmit={handleJobSubmit}
          showChat={showChat}
          chatWidth={chatWidth}
          onToggleChat={handleToggleChat}
          showSettings={showSettings}
          onToggleSettings={handleToggleSettings}
          onGraphDataChange={setChatGraphData}
          chatHighlightNodes={chatHighlightNodes}
          animationSettings={animationSettings}
        />

        {showChat && (
          <ChatPanel
            graphData={chatGraphData}
            onClose={() => setShowChat(false)}
            onNodeSelect={(nodeId) => {
              graphViewerRef.current?.selectNode(nodeId);
            }}
            onChatHighlight={(allIds, newIds) => {
              setChatHighlightNodes(allIds);
              if (newIds.length > 0) {
                graphViewerRef.current?.triggerPing(newIds);
              }
            }}
            onGraphChange={async (focusNodeId) => {
              // Reload scoped to the PR node — 2 hops shows PR → Files → their neighbors
              await graphViewerRef.current?.reload(focusNodeId, 2);
              if (focusNodeId) {
                // Wait for React to commit the re-render with new graph data
                setTimeout(() => {
                  graphViewerRef.current?.selectNode(focusNodeId, 2);
                }, 100);
              }
            }}
            repoUrl={activeRepoUrl}
            onWidthChange={handleChatWidthChange}
          />
        )}
      </div>

      {showSettings && (
        <SettingsDrawer
          onClose={() => setShowSettings(false)}
          onGraphCleared={() => {
            setShowSettings(false);
            graphViewerRef.current?.reload();
          }}
          onLimitsChanged={() => graphViewerRef.current?.reload()}
          onAnimationSettingsChanged={setAnimationSettings}
        />
      )}

      {(version || typeof __APP_VERSION__ !== 'undefined') && (
        <footer className="version-footer">
          v{version ?? __APP_VERSION__}
          {(buildTime ??
            (typeof __BUILD_TIME__ !== 'undefined'
              ? __BUILD_TIME__
              : undefined)) && (
            <>
              {' '}
              &middot; {new Date(buildTime ?? __BUILD_TIME__).toLocaleString()}
            </>
          )}
        </footer>
      )}
    </div>
  );
}
export default App;
