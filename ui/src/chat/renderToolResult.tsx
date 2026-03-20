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

export function createRenderToolResult(
  onNodeSelect?: (nodeId: string) => void,
  onPostComment?: (number: number, body: string) => Promise<void>,
): (name: string, args: string, result: string) => ReactNode | null {
  return (name: string, _args: string, result: string) => {
    switch (name) {
      case 'search_graph': {
        const nodes = parseSearchResult(result);
        return nodes ? (
          <NodeListResult nodes={nodes} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'list_nodes': {
        const nodes = parseListNodesResult(result);
        return nodes ? (
          <NodeListResult nodes={nodes} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'get_node': {
        const node = parseGetNodeResult(result);
        return node ? (
          <GetNodeResultView node={node} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'traverse_graph': {
        const entries = parseTraverseResult(result);
        return entries ? (
          <TraverseResultView entries={entries} onNodeSelect={onNodeSelect} />
        ) : null;
      }
      case 'suggest_comment':
      case 'comment_on_pr': {
        const comment = parseSuggestComment(result);
        return comment ? (
          <SuggestCommentResult comment={comment} onPost={onPostComment} />
        ) : null;
      }
      default:
        return null;
    }
  };
}
