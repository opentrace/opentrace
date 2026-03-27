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
import {
  DiscoverPanel,
  useDiscoverTree,
  type DiscoverDataProvider,
  type TreeNodeData,
} from '@opentrace/components';
import { PARSEABLE_EXTENSIONS } from '../runner/browser/loader/constants';

const EXPANDABLE_TYPES = new Set([
  'Repository',
  'Directory',
  'File',
  'Class',
  'PullRequest',
]);

function isExpandable(node: TreeNodeData): boolean {
  if (!EXPANDABLE_TYPES.has(node.type)) return false;
  if (node.type === 'File') {
    const dotIdx = node.name.lastIndexOf('.');
    return (
      dotIdx >= 0 &&
      PARSEABLE_EXTENSIONS.has(node.name.slice(dotIdx).toLowerCase())
    );
  }
  return true;
}

interface DiscoverPanelContainerProps {
  onSelectNode: (nodeId: string) => void;
  dataProvider: DiscoverDataProvider;
  graphVersion?: number;
  selectedNodeId?: string;
  graphNodeIds?: string[];
  hopMap?: Map<string, number>;
  isActive?: boolean;
}

export default function DiscoverPanelContainer({
  onSelectNode,
  dataProvider,
  graphVersion,
  selectedNodeId,
  graphNodeIds,
  hopMap,
  isActive,
}: DiscoverPanelContainerProps) {
  const {
    roots,
    childrenMap,
    expanded,
    loading,
    toggleExpand,
    collapseAll,
    expandAll,
    expandToNode,
  } = useDiscoverTree({
    dataProvider,
    refreshKey: graphVersion,
    isExpandable,
  });

  // Auto-expand tree path to the selected node
  useEffect(() => {
    if (selectedNodeId) {
      expandToNode(selectedNodeId);
    }
  }, [selectedNodeId, expandToNode]);

  if (loading) {
    return (
      <div className="discover-panel">
        <div className="discover-panel-empty">Loading repositories...</div>
      </div>
    );
  }

  return (
    <DiscoverPanel
      roots={roots}
      childrenMap={childrenMap}
      expanded={expanded}
      onToggleExpand={toggleExpand}
      onCollapseAll={collapseAll}
      onExpandAll={expandAll}
      onSelectNode={onSelectNode}
      selectedNodeId={isActive ? selectedNodeId : undefined}
      graphNodeIds={graphNodeIds}
      hopMap={hopMap}
      isExpandable={isExpandable}
    />
  );
}
