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
import { repoFromNodeId } from "../util/node-id.js"

export function createSemanticSearchTool(client: GraphClient) {
  return tool({
    description: `Search the knowledge graph using natural language descriptions. This finds code by meaning, not just keywords.
Example: "functions that validate user input" will find validation functions even if they're named "checkFormData" or "sanitize".
Uses OpenTrace's summarizer-generated descriptions for matching.
Falls back to FTS if semantic search is not available.`,
    args: {
      query: tool.schema.string().describe("Natural language description of the code you're looking for"),
      node_types: tool.schema.string().optional().describe("Comma-separated filter: Function, Class, Module, File"),
      limit: tool.schema.number().optional().describe("Max results (default 10)"),
    },
    async execute(args) {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      const results = await client.ftsSearch(args.query, {
        nodeTypes: args.node_types?.split(",").map((t) => t.trim()).filter(Boolean),
        limit: args.limit ?? 10,
      })

      if (!results.length) {
        return `No results found for "${args.query}". Try rephrasing or use opentrace_source_search for keyword search.`
      }

      const lines = results.map((node) => {
        const props = node.properties ?? {}
        const nodeRepo = repoFromNodeId(node.id)
        const parts = [`[${node.type}] ${node.name}`]
        parts.push(`  Repo: ${nodeRepo}`)
        if (props.path) parts.push(`  File: ${props.path}`)
        if (props.start_line != null) parts.push(`  Lines: ${props.start_line}-${props.end_line ?? "?"}`)
        if (props.signature) parts.push(`  Signature: ${props.signature}`)
        if (props.summary) parts.push(`  Summary: ${props.summary}`)
        if (props.docs) parts.push(`  Docs: ${props.docs.slice(0, 200)}`)
        parts.push(`  Node ID: ${node.id}`)
        return parts.join("\n")
      })

      return `Found ${results.length} result(s) matching "${args.query}":\n\n${lines.join("\n\n")}\n\nUse opentrace_source_read with a node ID to read the actual source code.`
    },
  })
}
