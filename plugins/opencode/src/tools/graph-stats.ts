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

export function createGraphStatsTool(client: GraphClient) {
  return tool({
    description: `Show an overview of all indexed repositories and graph statistics.
Lists every repo in the knowledge graph with node/edge counts by type.
Use this to understand what's available before searching.`,
    args: {},
    async execute() {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      const stats = await client.stats()
      if (!stats) {
        return "Failed to retrieve graph statistics."
      }

      const lines: string[] = [
        "OpenTrace Knowledge Graph",
        `  Total nodes: ${stats.total_nodes}`,
        `  Total edges: ${stats.total_edges}`,
      ]

      if (stats.nodes_by_type && Object.keys(stats.nodes_by_type).length > 0) {
        lines.push("", "Nodes by type:")
        const sorted = Object.entries(stats.nodes_by_type).sort((a, b) => b[1] - a[1])
        for (const [type, count] of sorted) {
          lines.push(`  ${type}: ${count}`)
        }
      }

      // List indexed repos
      const repos = await client.listRepos()
      if (repos.length) {
        lines.push("", `Indexed repositories (${repos.length}):`)
        for (const repo of repos) {
          const props = repo.properties
          const parts = [`  - ${repo.name}`]
          if (props.branch) parts.push(`[${props.branch}]`)
          if (props.sourceUri) parts.push(`(${props.sourceUri})`)
          lines.push(parts.join(" "))
        }
      }

      return lines.join("\n")
    },
  })
}
