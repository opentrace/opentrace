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

/**
 * Query the indexed graph — Cypher by default, full-text search as a
 * fallback. Wraps `opentraceai query`. Requires an existing index
 * (see opentrace_graph_build).
 */
export function createGraphQueryTool(client: GraphClient) {
  return tool({
    description: `Run a query against the OpenTrace knowledge graph. Pass a Cypher statement for structural questions ("MATCH (n:Node {type: 'Function'}) RETURN n.name LIMIT 10"), or set fts=true to full-text-search node names and content when you only know a keyword. Requires the graph to have been indexed first via opentrace_graph_build.`,
    args: {
      query: tool.schema.string().describe("Cypher statement, or a search term when fts=true."),
      fts: tool.schema.boolean().optional().describe("Treat `query` as a full-text search term instead of Cypher."),
      limit: tool.schema.number().optional().describe("Max rows for full-text search (default 100)."),
    },
    async execute(args) {
      const cliBlocked = await client.requireCliAvailable()
      if (cliBlocked) return cliBlocked

      const subArgs = ["query", args.query, "--output", "json"]
      if (args.fts) subArgs.push("--type", "fts")
      if (args.fts && typeof args.limit === "number") subArgs.push("--limit", String(args.limit))
      const out = await client.runReadOnly(subArgs, { surfaceErrors: true })
      return out ?? "query produced no output (has `opentraceai index` run yet?)"
    },
  })
}
