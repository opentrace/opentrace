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

/** User-friendly display names for OpenTrace graph tools */
export const TOOL_NAMES: Record<string, string> = {
  search_graph: 'Search Graph',
  list_nodes: 'List Nodes',
  get_node: 'Get Node',
  traverse_graph: 'Traverse Graph',
  load_source: 'Load Source',
  code_explorer: 'Code Explorer',
  dependency_analyzer: 'Dependency Analyzer',
  code_reviewer: 'Code Reviewer',
  suggest_comment: 'Suggest Comment',
  comment_on_pr: 'Comment on PR',
};

/** Tools that are actually sub-agents — rendered with distinct styling */
export const AGENT_TOOLS = new Set([
  'code_explorer',
  'dependency_analyzer',
  'code_reviewer',
]);
