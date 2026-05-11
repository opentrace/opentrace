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

export function createGraphExploreTool(client: GraphClient) {
  return tool({
    description: `Explore a specific node in the knowledge graph - see its details, properties, and all direct relationships.
Use this to understand the structure around a function, class, module, or file.
Shows both incoming (what depends on this) and outgoing (what this depends on) relationships.`,
    args: {
      node_id: tool.schema.string().optional().describe("Node ID to explore (from a previous search result)"),
      name: tool.schema.string().optional().describe("Node name to search for and explore"),
      type: tool.schema.string().optional().describe("Node type filter when searching by name: Function, Class, Module, File"),
    },
    async execute(args) {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      let nodeId = args.node_id

      // If searching by name, find the node first
      if (!nodeId && args.name) {
        const nodes = await client.ftsSearch(args.name, {
          nodeTypes: args.type ? [args.type] : undefined,
          limit: 1,
        })
        if (!nodes.length) {
          return `Node "${args.name}" not found. Try opentrace_source_search for a broader search.`
        }
        nodeId = nodes[0].id
      }

      if (!nodeId) {
        return "Please provide either a node_id or a name to explore."
      }

      const detail = await client.getNode(nodeId)
      if (!detail) {
        return `Node ${nodeId} not found in the graph.`
      }

      const { node, neighbors } = detail
      const props = node.properties ?? {}

      const nodeRepo = repoFromNodeId(node.id)

      const lines: string[] = [
        `[${node.type}] ${node.name}`,
        `  Repo: ${nodeRepo}`,
        `  ID: ${node.id}`,
      ]

      if (props.path) lines.push(`  File: ${props.path}`)
      if (props.start_line != null) lines.push(`  Lines: ${props.start_line}-${props.end_line ?? "?"}`)
      if (props.signature) lines.push(`  Signature: ${props.signature}`)
      if (props.language) lines.push(`  Language: ${props.language}`)
      if (props.docs) lines.push(`  Docs: ${props.docs.slice(0, 300)}`)
      if (props.summary) lines.push(`  Summary: ${props.summary}`)

      if (neighbors.length) {
        const incoming = neighbors.filter((n) => n.relationship.direction === "incoming")
        const outgoing = neighbors.filter((n) => n.relationship.direction === "outgoing")

        if (outgoing.length) {
          lines.push("", `Outgoing relationships (${outgoing.length}):`)
          for (const n of outgoing.slice(0, 20)) {
            lines.push(`  --${n.relationship.type}--> [${n.node.type}] ${n.node.name}`)
          }
          if (outgoing.length > 20) lines.push(`  ... and ${outgoing.length - 20} more`)
        }

        if (incoming.length) {
          lines.push("", `Incoming relationships (${incoming.length}):`)
          for (const n of incoming.slice(0, 20)) {
            lines.push(`  <--${n.relationship.type}-- [${n.node.type}] ${n.node.name}`)
          }
          if (incoming.length > 20) lines.push(`  ... and ${incoming.length - 20} more`)
        }
      } else {
        lines.push("", "No relationships found.")
      }

      return lines.join("\n")
    },
  })
}
