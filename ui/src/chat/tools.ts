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

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GraphStore } from '../store/types';

const MAX_RESULT_CHARS = 4000;
const MAX_SOURCE_CHARS = 8000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n...[truncated, ${text.length} chars total]`;
}

// ---- Tool schemas ----

const searchGraphSchema = z.object({
  query: z
    .string()
    .describe('Search text to match against node names and properties'),
  limit: z.number().optional().describe('Max results (default 50, max 1000)'),
  nodeTypes: z
    .string()
    .optional()
    .describe("Comma-separated node types to filter, e.g. 'Repository,Class'"),
});

const listNodesSchema = z.object({
  type: z.string().describe('Node type to list'),
  limit: z.number().optional().describe('Max results (default 50, max 1000)'),
  filters: z
    .string()
    .optional()
    .describe(
      'Property filters as a JSON object string for AND matching, e.g. \'{"language":"go","team":"platform"}\'',
    ),
});

const getNodeSchema = z.object({
  nodeId: z.string().describe('The node ID to look up'),
});

const traverseGraphSchema = z.object({
  nodeId: z.string().describe('Starting node ID'),
  depth: z
    .number()
    .optional()
    .describe('Max traversal depth (default 3, max 10)'),
  direction: z
    .enum(['outgoing', 'incoming', 'both'])
    .optional()
    .describe("Traversal direction (default 'outgoing')"),
  relationship: z
    .string()
    .optional()
    .describe("Filter by relationship type, e.g. 'CALLS', 'DEFINES', 'IMPORTS'"),
});

const loadSourceSchema = z.object({
  nodeId: z
    .string()
    .describe(
      'Node ID of a File, Class, or Function. ' +
        "Symbol IDs like 'owner/repo/path.py::ClassName' are automatically resolved to their file.",
    ),
  startLine: z
    .number()
    .optional()
    .describe('Start line (1-based) for a partial read'),
  endLine: z
    .number()
    .optional()
    .describe('End line (1-based) for a partial read'),
});

// ---- Tool descriptions ----

const SEARCH_DESC =
  'Full-text search across graph nodes by name or properties. ' +
  'Returns matching nodes with their types and properties.';

const LIST_DESC =
  'List nodes of a specific type. Valid types include: Repository, ' +
  'Class, Function, File, Directory, Dependency, PullRequest.';

const GET_DESC =
  'Get full details of a single node by its ID, including all properties.';

const TRAVERSE_DESC =
  'BFS traversal from a node to discover connected nodes and relationships. ' +
  "Use direction 'outgoing' for downstream dependencies, 'incoming' for upstream, " +
  "or 'both' for all connections.";

const LOAD_SOURCE_DESC =
  'Fetch source code for an indexed file or symbol. ' +
  "Accepts a File node ID or a symbol ID (e.g. 'owner/repo/src/main.py::MyClass') — " +
  'symbol suffixes are stripped automatically to find the file. ' +
  'Use startLine/endLine for partial reads. Only works for files loaded during indexing.';

// ---- Factory: returns tools wired to a GraphStore ----

export function makeGraphTools(store: GraphStore) {
  return [
    tool(
      async ({ query, limit, nodeTypes }) => {
        const types = nodeTypes
          ? nodeTypes.split(',').map((t) => t.trim())
          : undefined;
        const results = await store.searchNodes(query, limit, types);
        return truncate(
          JSON.stringify({ results, count: results.length }),
          MAX_RESULT_CHARS,
        );
      },
      {
        name: 'search_graph',
        description: SEARCH_DESC,
        schema: searchGraphSchema,
      },
    ),
    tool(
      async ({ type, limit, filters }) => {
        let parsedFilters: Record<string, string> | undefined;
        if (filters) {
          try {
            parsedFilters = JSON.parse(filters);
          } catch {
            return JSON.stringify({ error: 'Invalid filters JSON', filters });
          }
        }
        const nodes = await store.listNodes(type, limit, parsedFilters);
        return truncate(
          JSON.stringify({ nodes, count: nodes.length }),
          MAX_RESULT_CHARS,
        );
      },
      { name: 'list_nodes', description: LIST_DESC, schema: listNodesSchema },
    ),
    tool(
      async ({ nodeId }) => {
        const node = await store.getNode(nodeId);
        if (!node)
          return JSON.stringify({ error: 'Node not found', id: nodeId });
        return truncate(JSON.stringify(node), MAX_RESULT_CHARS);
      },
      { name: 'get_node', description: GET_DESC, schema: getNodeSchema },
    ),
    tool(
      async ({ nodeId, depth, direction, relationship }) => {
        const results = await store.traverse(
          nodeId,
          direction,
          depth,
          relationship,
        );
        return truncate(
          JSON.stringify({ results, count: results.length }),
          MAX_RESULT_CHARS,
        );
      },
      {
        name: 'traverse_graph',
        description: TRAVERSE_DESC,
        schema: traverseGraphSchema,
      },
    ),
    tool(
      async ({ nodeId, startLine, endLine }) => {
        const result = await store.fetchSource(nodeId, startLine, endLine);
        if (!result)
          return JSON.stringify({ error: 'Source not found', nodeId });
        return truncate(
          JSON.stringify({
            path: result.path,
            line_count: result.line_count,
            startLine: result.startLine,
            endLine: result.endLine,
            content: result.content,
          }),
          MAX_SOURCE_CHARS,
        );
      },
      {
        name: 'load_source',
        description: LOAD_SOURCE_DESC,
        schema: loadSourceSchema,
      },
    ),
  ];
}
