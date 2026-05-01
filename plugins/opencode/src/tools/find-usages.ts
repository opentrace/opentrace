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
import { filePathFromNodeId, repoFromNodeId } from "../util/node-id.js"

export function createFindUsagesTool(client: GraphClient) {
  return tool({
    description: `Find all callers, importers, and dependents of a symbol across ALL indexed repositories.
Walks incoming relationships (CALLS, IMPORTS, DEPENDS_ON, EXTENDS, IMPLEMENTS) in the knowledge graph.
Use this before refactoring to understand who uses a function/class/module.
Use this to understand how a library API is consumed across projects.`,
    args: {
      symbol: tool.schema.string().describe("Name of the function, class, or module to find usages of"),
      type: tool.schema.string().optional().describe("Node type filter: Function, Class, Module, File"),
      depth: tool.schema.number().int().min(1).max(5).default(2).describe("How many hops to traverse (1-5, default 2)"),
    },
    async execute(args) {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      // First find the symbol
      const nodes = await client.ftsSearch(args.symbol, {
        nodeTypes: args.type ? [args.type] : undefined,
        limit: 5,
      })

      if (!nodes.length) {
        return `Symbol "${args.symbol}" not found in the knowledge graph. Try opentrace_source_search for a broader search.`
      }

      // For the best match, traverse incoming relationships. Schema
      // already constrained depth to 1..5 with a default of 2.
      const target = nodes[0]
      const targetRepo = repoFromNodeId(target.id)
      const usages = await client.traverse(
        target.id,
        "incoming",
        args.depth,
      )

      const header = `Usages of [${target.type}] ${target.name} (${targetRepo}):`
      if (!usages.length) {
        return `${header}\n\nNo incoming references found. This symbol may not be called/imported by any indexed code.`
      }

      // Group by repo, then by type
      const byRepo: Record<string, Record<string, typeof usages>> = {}
      for (const entry of usages) {
        const repo = repoFromNodeId(entry.node.id)
        const type = entry.node.type
        if (!byRepo[repo]) byRepo[repo] = {}
        if (!byRepo[repo][type]) byRepo[repo][type] = []
        byRepo[repo][type].push(entry)
      }

      const sections: string[] = []
      for (const [repo, types] of Object.entries(byRepo)) {
        const repoLabel = repo === targetRepo ? `${repo} (same repo)` : repo
        const typeLines: string[] = []
        for (const [type, entries] of Object.entries(types)) {
          const items = entries.map((e) => {
            const props = e.node.properties ?? {}
            // Extract file path from node ID if not in properties
            let loc = ""
            if (props.path) {
              loc = ` (${props.path}:${props.start_line ?? "?"})`
            } else {
              const filePath = filePathFromNodeId(e.node.id)
              if (filePath) loc = ` (${filePath})`
            }
            return `    - ${e.node.name}${loc}`
          })
          typeLines.push(`  ${type} (${entries.length}):\n${items.join("\n")}`)
        }
        sections.push(`[${repoLabel}]\n${typeLines.join("\n")}`)
      }

      return `${header}\n\n${sections.join("\n\n")}\n\nTotal: ${usages.length} reference(s) across ${Object.keys(byRepo).length} repo(s).`
    },
  })
}
