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

export function createSourceReadTool(client: GraphClient) {
  return tool({
    description: `Read source code from any indexed repository. Use this INSTEAD of the regular read tool for files in indexed repos - it avoids external directory permission prompts.
Accepts a node ID (from opentrace_source_search results) or a file path.
Returns the source code with line numbers.
Use this for reading code in dependency libraries, external repos, or any repo indexed by OpenTrace.`,
    args: {
      node_id: tool.schema.string().optional().describe("Node ID from a previous search result (preferred)"),
      path: tool.schema.string().optional().describe("File path relative to repo root (e.g., 'src/router.ts')"),
      start_line: tool.schema.number().optional().describe("Starting line number (1-indexed)"),
      end_line: tool.schema.number().optional().describe("Ending line number"),
    },
    async execute(args) {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      if (!args.node_id && !args.path) {
        return "Please provide either a node_id (from search results) or a file path."
      }

      let source: string | null

      if (args.node_id) {
        source = await client.readSource({ nodeId: args.node_id })
      } else {
        source = await client.readSource({
          path: args.path!,
          startLine: args.start_line,
          endLine: args.end_line,
        })
      }

      if (!source) {
        return "Could not read source. The file may not be available locally. Check if the repository needs to be cloned."
      }

      return source
    },
  })
}
