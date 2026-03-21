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
import GraphViewer from './components/GraphViewer';
import type { GraphViewerHandle } from './components/GraphViewer';
import ChatPanel from './components/ChatPanel';
import SettingsDrawer from './components/SettingsDrawer';
import type { GraphNode, GraphLink } from '@opentrace/components/utils';
import { loadAnimationSettings } from './config/animation';
import type { AnimationSettings } from '@opentrace/components';
import './App.css';

const EMPTY_GRAPH: { nodes: GraphNode[]; links: GraphLink[] } = {
  nodes: [],
  links: [],
};

function App() {
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

  const [showChat, setShowChat] = useState(true);
  const [chatWidth, setChatWidth] = useState(480);
  const [showSettings, setShowSettings] = useState(false);
  const [animationSettings, setAnimationSettings] = useState<AnimationSettings>(
    loadAnimationSettings,
  );
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [activeRepoUrl, setActiveRepoUrl] = useState('');
  const [jobExpanded, setJobExpanded] = useState(false);
  const [dimensions, setDimensions] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const onResize = () =>
      setDimensions({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleJobSubmit = useCallback(
    (message: JobMessage) => {
      if (message.type === 'index-repo') {
        setActiveRepoUrl(message.repoUrl);
      } else if (message.type === 'index-directory') {
        setActiveRepoUrl(`local/${message.name}`);
      }
      setShowAddRepo(false);
      setJobExpanded(false);
      startJob(message);
    },
    [startJob],
  );

  const handleJobClose = useCallback(() => {
    resetJob();
    setJobExpanded(false);
  }, [resetJob]);

  const handleCancelJob = useCallback(() => {
    cancelJob();
    setJobExpanded(false);
  }, [cancelJob]);

  const handleJobMinimize = useCallback(() => minimizeJob(), [minimizeJob]);
  const handleJobExpand = useCallback(() => setJobExpanded(true), []);
  const handleAddRepoOpen = useCallback(() => setShowAddRepo(true), []);
  const handleAddRepoClose = useCallback(() => setShowAddRepo(false), []);
  const handleToggleChat = useCallback(() => setShowChat((v) => !v), []);
  const handleChatWidthChange = useCallback((w: number) => setChatWidth(w), []);
  const handleToggleSettings = useCallback(
    () => setShowSettings((v) => !v),
    [],
  );

  return (
    <div className="app">
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
          animationSettings={animationSettings}
        />

        {showChat && (
          <ChatPanel
            graphData={chatGraphData}
            onClose={() => setShowChat(false)}
            onNodeSelect={(nodeId) => {
              graphViewerRef.current?.selectNode(nodeId);
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

      <footer className="version-footer">
        v{__APP_VERSION__} &middot; {new Date(__BUILD_TIME__).toLocaleString()}
      </footer>
    </div>
  );
}
export default App;
