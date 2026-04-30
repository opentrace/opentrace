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

export function createImpactAnalysisTool(client: GraphClient) {
  return tool({
    description: `Analyze the blast radius of changes to a file or symbol. Shows everything that depends on the target across ALL indexed repositories.
Use this BEFORE making changes to understand what could break.
Use this AFTER making changes to verify nothing was missed.
Checks CALLS, IMPORTS, DEPENDS_ON, EXTENDS, and IMPLEMENTS relationships.`,
    args: {
      target: tool.schema.string().describe("File path or symbol name to analyze"),
      lines: tool.schema.string().optional().describe("Line range to narrow analysis, e.g. '10-25' or '10-25,40-60'"),
    },
    async execute(args) {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      const result = await client.impact(args.target, args.lines)

      if (!result) {
        return `No impact data found for "${args.target}". The file/symbol may not be indexed. Try opentrace_source_search to check.`
      }

      return result
    },
  })
}
