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

import { tool } from "@opencode-ai/plugin"
import type { GraphClient } from "../graph-client.js"

export function createSourceSearchTool(client: GraphClient) {
  return tool({
    description: `Search across ALL indexed repositories using full-text search. Searches node names, types, summaries, and file paths across every repo in the OpenTrace knowledge graph.
Use this to find functions, classes, modules, or files by keyword.
Results include the symbol name, type, repo, file path, and line range.
To read the actual source code of a result, use opentrace_source_read with the node ID.`,
    args: {
      query: tool.schema.string().describe("Search query - keywords to find in function/class/module names, summaries, and paths"),
      node_types: tool.schema.string().optional().describe("Comma-separated node type filter: Function, Class, Module, File, Variable, Repository"),
      repo: tool.schema.string().optional().describe("Filter to a specific repo by id (use the id shown in the system prompt's indexed-repositories list)"),
      limit: tool.schema.number().optional().describe("Max results to return (default 20)"),
    },
    async execute(args) {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      const text = await client.sourceSearchText(args.query, {
        repo: args.repo,
        nodeTypes: args.node_types?.split(",").map((t) => t.trim()).filter(Boolean),
        limit: args.limit ?? 20,
      })
      return text ?? `No results found for "${args.query}".`
    },
  })
}
