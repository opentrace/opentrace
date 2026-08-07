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
 * Index a folder and run community detection over the result. Wraps
 * `opentraceai index` followed by `opentraceai cluster`.
 *
 * Both run on the INDEX timeout, not the default 10s command budget — see
 * `GraphClient.indexRepo` / `clusterGraph`.
 */
export function createGraphBuildTool(client: GraphClient) {
  return tool({
    description: `Index a folder into the OpenTrace knowledge graph and run community detection on the result, so analyze/report tooling has cluster data to work with. Use when the user says things like "index this repo", "build the graph", or "map this codebase".`,
    args: {
      path: tool.schema.string().optional().describe("Folder to index. Default '.'."),
    },
    async execute(args) {
      const cliBlocked = await client.requireCliAvailable()
      if (cliBlocked) return cliBlocked

      // Both steps go through the INDEX timeout (30 min), not the default 10s
      // `run()` budget — indexing or clustering any real repo takes longer than
      // ten seconds, so the subprocess was being killed mid-walk and the tool
      // returned partial stderr as if that were the result.
      const indexed = await client.indexRepo(args.path ?? ".")
      if (!indexed.ok) return indexed.message

      const clustered = await client.clusterGraph()
      const combined = [indexed.message, clustered.message].filter(Boolean).join("\n")
      return combined || "index produced no output"
    },
  })
}
