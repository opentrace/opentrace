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

import type { ReactNode } from 'react';
import type { ChatToolConfig } from '@opentrace/components/chat';
import {
  parseSearchResult,
  parseListNodesResult,
  parseGetNodeResult,
  parseTraverseResult,
} from './results/parsers';
import NodeListResult from './results/NodeListResult';
import GetNodeResultView from './results/GetNodeResult';
import TraverseResultView from './results/TraverseResult';
import SuggestCommentResult, {
  parseSuggestComment,
} from './results/SuggestCommentResult';

/** Build the OpenTrace tool config with result renderers wired to callbacks. */
export function buildToolConfig(
  onNodeSelect?: (nodeId: string) => void,
  onPostComment?: (number: number, body: string) => Promise<void>,
): Record<string, ChatToolConfig> {
  function nodeListRenderer(_args: string, result: string): ReactNode | null {
    const nodes = parseSearchResult(result);
    return nodes ? (
      <NodeListResult nodes={nodes} onNodeSelect={onNodeSelect} />
    ) : null;
  }

  return {
    search_graph: {
      displayName: 'Search Graph',
      renderResult: nodeListRenderer,
    },
    list_nodes: {
      displayName: 'List Nodes',
      renderResult: (_args, result) => {
        const nodes = parseListNodesResult(result);
        return nodes ? (
          <NodeListResult nodes={nodes} onNodeSelect={onNodeSelect} />
        ) : null;
      },
    },
    get_node: {
      displayName: 'Get Node',
      renderResult: (_args, result) => {
        const node = parseGetNodeResult(result);
        return node ? (
          <GetNodeResultView node={node} onNodeSelect={onNodeSelect} />
        ) : null;
      },
    },
    traverse_graph: {
      displayName: 'Traverse Graph',
      renderResult: (_args, result) => {
        const entries = parseTraverseResult(result);
        return entries ? (
          <TraverseResultView entries={entries} onNodeSelect={onNodeSelect} />
        ) : null;
      },
    },
    load_source: {
      displayName: 'Load Source',
    },
    code_explorer: {
      displayName: 'Code Explorer',
      isAgent: true,
    },
    dependency_analyzer: {
      displayName: 'Dependency Analyzer',
      isAgent: true,
    },
    code_reviewer: {
      displayName: 'Code Reviewer',
      isAgent: true,
    },
    suggest_comment: {
      displayName: 'Suggest Comment',
      renderResult: (_args, result) => {
        const comment = parseSuggestComment(result);
        return comment ? (
          <SuggestCommentResult comment={comment} onPost={onPostComment} />
        ) : null;
      },
    },
    comment_on_pr: {
      displayName: 'Comment on PR',
      renderResult: (_args, result) => {
        const comment = parseSuggestComment(result);
        return comment ? (
          <SuggestCommentResult comment={comment} onPost={onPostComment} />
        ) : null;
      },
    },
  };
}
