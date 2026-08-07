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
import type { GraphStore, NodeResult } from '../store/types';

const MAX_RESULT_CHARS = 4000;
const MAX_SOURCE_CHARS = 8000;
const MAX_EXPLORE_CHARS = 12000;

/**
 * Truncate a JSON-serializable value to fit within a character limit.
 * Instead of slicing the JSON string (which produces invalid JSON),
 * we progressively trim array entries or string fields until it fits.
 */
/** Pre-summarise a neighbour for agent legibility. Mirrors the Python
 *  `_neighbour_summary` helper in `mcp_server.py`. */
function neighbourSummary(node: NodeResult): string {
  const props = (node.properties ?? {}) as Record<string, unknown>;
  const oneLine = props.one_line_summary;
  if (typeof oneLine === 'string' && oneLine.trim()) return oneLine.trim();
  const summary = props.summary;
  if (typeof summary === 'string' && summary.trim()) {
    const text = summary.trim();
    return text.length <= 200 ? text : text.slice(0, 197) + '...';
  }
  return String(node.name ?? node.id ?? '');
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;

  // Try to parse and trim the data structurally to keep valid JSON
  try {
    const data = JSON.parse(text);
    // If the root has a list-bearing key, trim entries from the end. The set
    // covers the existing tools plus the OT-1732 retrieval responses.
    const arrayKey =
      (['hits', 'results', 'nodes', 'orphans', 'pairs'] as const).find((k) =>
        Array.isArray((data as Record<string, unknown>)[k]),
      ) ?? null;
    if (arrayKey && Array.isArray(data[arrayKey])) {
      while (data[arrayKey].length > 1) {
        data[arrayKey].pop();
        const attempt = JSON.stringify({ ...data, truncated: true });
        if (attempt.length <= limit) return attempt;
      }
      // A single remaining entry can still exceed the limit; fall back to the
      // valid-JSON envelope rather than slicing a JSON string into garbage.
      return JSON.stringify({
        partial: text.slice(0, limit - 50),
        truncated: true,
      });
    }
    // For non-array results (e.g. explore_node), truncate source content string
    if (data.source?.content && typeof data.source.content === 'string') {
      while (data.source.content.length > 100) {
        data.source.content = data.source.content.slice(
          0,
          Math.floor(data.source.content.length / 2),
        );
        const attempt = JSON.stringify({ ...data, truncated: true });
        if (attempt.length <= limit) return attempt;
      }
    }
  } catch {
    // Not valid JSON — fall through to raw slice
  }
  // Last resort: slice and wrap in a valid JSON envelope
  return JSON.stringify({
    partial: text.slice(0, limit - 50),
    truncated: true,
  });
}

// ---- Tool schemas ----

const searchGraphSchema = z.object({
  query: z
    .string()
    .describe(
      'Search text to match against node names, properties, and file content. ' +
        'For compound identifiers (e.g. "my-service-name"), try both hyphenated and space-separated forms.',
    ),
  limit: z.number().optional().describe('Max results (default 50, max 1000)'),
  nodeTypes: z
    .string()
    .optional()
    .describe("Comma-separated node types to filter, e.g. 'Repository,Class'"),
  vaultScope: z
    .string()
    .optional()
    .describe('Restrict to nodes in a single vault by name.'),
});

const listNodesSchema = z.object({
  type: z.string().describe('Node type to list'),
  limit: z.number().optional().describe('Max results (default 50, max 1000)'),
  filters: z
    .string()
    .optional()
    .describe(
      'Property filters as a JSON object string for AND matching. Values ' +
        'containing "*" are wildcard patterns (e.g. {"name":"*Service"} for ' +
        'names ending in Service). Plain values match exactly. ' +
        'Example: \'{"language":"go","name":"*Service"}\'',
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
    .describe(
      "Filter by a single relationship type, e.g. 'CALLS'. " +
        'For multiple types, use edgeTypes instead.',
    ),
  edgeTypes: z
    .string()
    .optional()
    .describe(
      "Comma-separated allowlist of relationship types, e.g. 'CALLS,IMPORTS'. " +
        'Supersedes `relationship` when both are given.',
    ),
  vaultScope: z
    .string()
    .optional()
    .describe(
      'Restrict traversal to nodes belonging to this vault, by name. ' +
        "Membership follows CONTAINS edges, so it reaches the vault's documents.",
    ),
  confidenceThreshold: z
    .number()
    .optional()
    .describe(
      'Skip relationships with confidence below this threshold (0.0–1.0). ' +
        'Only CALLS edges carry a confidence; edges without one are kept.',
    ),
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

const exploreNodeSchema = z.object({
  nodeId: z.string().describe('Node ID to explore in depth'),
  includeSource: z
    .boolean()
    .optional()
    .describe('Include source code snippet (default true)'),
  depth: z
    .number()
    .optional()
    .describe('Relationship traversal depth (default 1, max 3)'),
});

const findPathSchema = z.object({
  startId: z.string().describe('ID of the start node'),
  endId: z.string().describe('ID of the end node'),
  maxHops: z
    .number()
    .optional()
    .describe('Max path length (default 5, max 10)'),
  edgeTypes: z
    .string()
    .optional()
    .describe(
      "Comma-separated edge types to allow on the walk, e.g. 'CALLS,IMPORTS'. " +
        'Empty = any edge type.',
    ),
});

const findOrphansSchema = z.object({
  nodeType: z
    .string()
    .describe('Node type to scan, e.g. Function or KnowledgeDoc'),
  edgeType: z
    .string()
    .describe(
      "Edge type to consider, e.g. 'CALLS' or 'LINKS_TO'. Nodes with no edges " +
        'of this type in the chosen direction are returned as orphans.',
    ),
  direction: z
    .enum(['incoming', 'outgoing', 'both'])
    .optional()
    .describe("Default 'incoming' (e.g. functions never called)."),
  limit: z.number().optional().describe('Max results (default 1000)'),
});

const findViaSchema = z.object({
  startType: z.string().describe('Type of the source node, e.g. Function'),
  edgeType: z.string().describe("Edge type, e.g. 'CALLS' or 'LINKS_TO'"),
  targetType: z.string().describe('Type of the target node, e.g. Endpoint'),
  limit: z.number().optional().describe('Max pairs (default 100, max 1000)'),
});

const countBySchema = z.object({
  nodeType: z.string().describe('Node type to count'),
  parentId: z
    .string()
    .optional()
    .describe(
      'Optional parent node ID. When set, counts only descendants reachable ' +
        'from the parent via parentEdge.',
    ),
  parentEdge: z
    .string()
    .optional()
    .describe("Containment edge type, default 'CONTAINS'"),
  maxHops: z
    .number()
    .optional()
    .describe('Max descendant hops from parent (default 3, max 5)'),
});

const provenanceSchema = z.object({
  nodeId: z.string().describe('Node ID to fetch provenance for'),
});

const overviewSchema = z.object({
  topN: z
    .number()
    .optional()
    .describe('Top-N items per section (default 5, max 20)'),
  vaultScope: z
    .string()
    .optional()
    .describe(
      'Restrict the whole response to a specific vault by name. ' +
        'An unknown name yields empty counts, not the unscoped graph.',
    ),
});

const grepSchema = z.object({
  pattern: z
    .string()
    .describe(
      'Regex pattern to search for. Examples: "TODO", "apiEndpoint", ' +
        '"coms-license-service".',
    ),
  scopeId: z
    .string()
    .describe(
      'Repository or Vault node ID whose on-disk subtree to search. ' +
        'Use list_nodes(type="Repository") or list_nodes(type="KnowledgeVault") to discover.',
    ),
  fileFilter: z
    .string()
    .optional()
    .describe(
      'Only search files whose path contains this string (e.g. ".cfm", "src/api")',
    ),
  caseSensitive: z
    .boolean()
    .optional()
    .describe('Case-sensitive search (default: false)'),
  maxResults: z
    .number()
    .optional()
    .describe('Max results to return (default: 200, max 5000)'),
});

// ---- Tool descriptions ----

const SEARCH_DESC =
  'Ranked FTS search across graph nodes. Returns {hits, count, query} where ' +
  'each hit is {id, type, name, snippet, score, vault, recency, confidence}. ' +
  'Most efficient way to find nodes — prefer this over list_nodes + traverse_graph.';

const LIST_DESC =
  'List nodes of a specific type with optional property filters. Valid ' +
  'types include Repository, Class, Function, File, Directory, Dependency, ' +
  'Vault, Page, Source. Filter values containing "*" are wildcards: ' +
  '`{"name":"*Service"}` matches anything ending in Service.';

const GET_DESC =
  'Get full details of a single node plus its 1-hop neighbours. Each ' +
  'neighbour includes a pre-summarised target_summary so you can decide ' +
  'whether to recurse without an extra fetch.';

const TRAVERSE_DESC =
  'BFS traversal from a node to discover connected nodes and relationships. ' +
  "direction='outgoing' for downstream, 'incoming' for upstream, 'both' for either. " +
  'Filter by a single edge type via `relationship`, or a set via `edgeTypes` ' +
  '(comma-separated, supersedes `relationship`). Optional `vaultScope` ' +
  'restricts to nodes in one vault; `confidenceThreshold` skips low-confidence rels.';

const LOAD_SOURCE_DESC =
  'Fetch source code for an indexed file or symbol. ' +
  "Accepts a File node ID or a symbol ID (e.g. 'owner/repo/src/main.py::MyClass') — " +
  'symbol suffixes are stripped automatically to find the file. ' +
  'Use startLine/endLine for partial reads. Only works for files loaded during indexing.';

const EXPLORE_DESC =
  'Deep inspection of a single node — returns full properties, incoming and outgoing ' +
  'relationships, and source code in one call. Use this instead of separate get_node + ' +
  'traverse_graph + load_source calls when you want to understand a specific component.';

const PROVENANCE_DESC =
  'Return the trust chain for a node. For an indexed document: its own ' +
  'identity — sha256, filename, root-relative path, ingest time. ' +
  'For code nodes: commit_sha + indexer_version from the per-repo metadata, ' +
  'plus file_path and line_range from the node itself.';

const OVERVIEW_DESC =
  'Compact orientation of the indexed graph for session start. Returns ' +
  'counts by node type, top-degree concepts, and recently-updated entities. ' +
  'Use this as the FIRST tool call to understand what is in the graph before ' +
  'targeted queries.';

const FIND_PATH_DESC =
  'Find the shortest outgoing-edge path between two nodes. Returns the chain ' +
  'of {node, relationship, depth} steps from start to end, or path:null if ' +
  'unreachable within maxHops. Optionally restrict the walk to specific edge ' +
  'types (e.g. only CALLS).';

const FIND_ORPHANS_DESC =
  'Find nodes of a given type that have no edges of edgeType in the given ' +
  'direction. Use this for cleanup/audit questions like finding functions ' +
  'never called (Function, CALLS, incoming) or documents nothing links to ' +
  '(KnowledgeDoc, LINKS_TO, incoming).';

const FIND_VIA_DESC =
  'Find all (A, B) pairs where A is startType, B is targetType, and a ' +
  'relationship of edgeType points from A to B. Examples: ' +
  '("Function","CALLS","Endpoint") for "what hits the API"; ' +
  '("KnowledgeDoc","LINKS_TO","KnowledgeDoc") for "which documents reference which." ' +
  'Cheaper than calling traverse_graph once per source node.';

const COUNT_BY_DESC =
  'Count nodes of nodeType, globally or scoped to descendants of a parent. ' +
  'Without parentId: total count. With parentId: count of descendants of ' +
  'parent reachable via parentEdge (default CONTAINS) within maxHops. ' +
  'Examples: count_by("Function") for total function count; ' +
  'count_by("KnowledgeDoc", parentId="vault::kb", parentEdge="CONTAINS") for ' +
  '"how many documents in the kb vault."';

const GREP_DESC =
  'Regex grep over the on-disk content reachable from a Repository or ' +
  'Vault scope. Returns file paths, line numbers, and matching text. ' +
  'Best for finding specific strings (service names, API endpoints, error ' +
  'messages, config values) that may not appear in node names. Requires ' +
  'the scope node to have on-disk content available — falls back to a ' +
  'structured error in browser-mode or when local_path is unset; use ' +
  'search_graph for FTS over indexed metadata in those cases.';

// ---- Factory: returns tools wired to a GraphStore ----

export function makeGraphTools(store: GraphStore) {
  return [
    tool(
      async ({ query, limit, nodeTypes, vaultScope }) => {
        const types = nodeTypes
          ? nodeTypes
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;
        const result = await store.search(query, {
          limit,
          nodeTypes: types,
          vaultScope: vaultScope || undefined,
        });
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
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
      async ({
        nodeId,
        depth,
        direction,
        relationship,
        edgeTypes,
        vaultScope,
        confidenceThreshold,
      }) => {
        const relList = edgeTypes
          ? edgeTypes
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;
        const results = await store.traverse(
          nodeId,
          direction,
          depth,
          // single-rel form is ignored when edgeTypes set provides a list
          relList ? undefined : relationship,
          {
            relTypes: relList,
            vaultScope: vaultScope || undefined,
            confidenceThreshold,
          },
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
            start_line: result.start_line,
            end_line: result.end_line,
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
    tool(
      async ({ nodeId, includeSource = true, depth = 1 }) => {
        // 1. Get node details
        const node = await store.getNode(nodeId);
        if (!node)
          return JSON.stringify({ error: 'Node not found', id: nodeId });

        // 2. Get relationships (capped depth)
        const traverseDepth = Math.min(depth, 3);
        const rels = await store.traverse(nodeId, 'both', traverseDepth);

        const connections = rels.map((r) => ({
          type: r.relationship.type,
          direction:
            r.relationship.source_id === nodeId ? 'outgoing' : 'incoming',
          nodeId: r.node.id,
          nodeName: r.node.name,
          nodeType: r.node.type,
          depth: r.depth,
          targetSummary: neighbourSummary(r.node),
        }));

        // 3. Optionally include source code
        let source: {
          path: string;
          content: string;
          line_count: number;
        } | null = null;
        if (includeSource) {
          // For symbol nodes (e.g. "repo/path::Class"), also try the file ID
          const result = await store.fetchSource(nodeId);
          if (result) {
            source = {
              path: result.path,
              content: result.content,
              line_count: result.line_count,
            };
          }
        }

        const result: Record<string, unknown> = {
          node,
          connections,
          connectionCount: connections.length,
        };
        if (includeSource) {
          result.source = source;
        }
        return truncate(JSON.stringify(result), MAX_EXPLORE_CHARS);
      },
      {
        name: 'explore_node',
        description: EXPLORE_DESC,
        schema: exploreNodeSchema,
      },
    ),
    tool(
      async ({ topN, vaultScope }) => {
        const result = await store.overview({ topN, vaultScope });
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
      },
      {
        name: 'overview',
        description: OVERVIEW_DESC,
        schema: overviewSchema,
      },
    ),
    tool(
      async ({ nodeId }) => {
        const result = await store.provenance(nodeId);
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
      },
      {
        name: 'provenance',
        description: PROVENANCE_DESC,
        schema: provenanceSchema,
      },
    ),
    tool(
      async ({ startId, endId, maxHops, edgeTypes }) => {
        const edgeList = edgeTypes
          ? edgeTypes
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined;
        const result = await store.findPath(startId, endId, maxHops, edgeList);
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
      },
      {
        name: 'find_path',
        description: FIND_PATH_DESC,
        schema: findPathSchema,
      },
    ),
    tool(
      async ({ nodeType, edgeType, direction, limit }) => {
        const result = await store.findOrphans(
          nodeType,
          edgeType,
          direction,
          limit,
        );
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
      },
      {
        name: 'find_orphans',
        description: FIND_ORPHANS_DESC,
        schema: findOrphansSchema,
      },
    ),
    tool(
      async ({ startType, edgeType, targetType, limit }) => {
        const result = await store.findViaRelationshipToType(
          startType,
          edgeType,
          targetType,
          limit,
        );
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
      },
      {
        name: 'find_via_relationship_to_type',
        description: FIND_VIA_DESC,
        schema: findViaSchema,
      },
    ),
    tool(
      async ({ nodeType, parentId, parentEdge, maxHops }) => {
        const result = await store.countBy(nodeType, {
          parentId,
          parentEdge,
          maxHops,
        });
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
      },
      {
        name: 'count_by',
        description: COUNT_BY_DESC,
        schema: countBySchema,
      },
    ),
    tool(
      async ({ pattern, scopeId, fileFilter, caseSensitive, maxResults }) => {
        const result = await store.grep(pattern, scopeId, {
          fileFilter,
          caseSensitive,
          maxResults,
        });
        return truncate(JSON.stringify(result), MAX_RESULT_CHARS);
      },
      { name: 'grep', description: GREP_DESC, schema: grepSchema },
    ),
  ];
}
