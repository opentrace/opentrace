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

export function createSourceGrepTool(client: GraphClient) {
  return tool({
    description: `Search for a regex pattern across all indexed repository files.
Unlike opentrace_source_search (which searches the knowledge graph), this searches actual file contents using ripgrep.
Use this when you need exact pattern matching (regex, string literals) across dependency code.
Results show repo-relative paths. Use opentrace_source_read to read matched files.`,
    args: {
      pattern: tool.schema.string().describe("Regex pattern to search for"),
      repo: tool.schema.string().optional().describe("Filter to a specific repo by id (use the id shown in the system prompt's indexed-repositories list)"),
      include: tool.schema.string().optional().describe("File glob filter, e.g., '*.ts' or '*.py'"),
      limit: tool.schema.number().optional().describe("Max matches per repo (default 50)"),
    },
    async execute(args) {
      const blocked = await client.requireDbAvailable()
      if (blocked) return blocked

      const text = await client.sourceGrepText(args.pattern, {
        repo: args.repo,
        include: args.include,
        limit: args.limit ?? 50,
      })
      return text ?? `No matches for "${args.pattern}".`
    },
  })
}
