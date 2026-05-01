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

import type { GraphClient } from "../graph-client.js"
import { debug } from "../util/debug.js"

/**
 * Hook for tool.execute.after — appends blast radius info after Edit/Write operations.
 * Has a 3s timeout so it never blocks tool results.
 */
export function createToolImpactHook(client: GraphClient) {
  return async (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => {
    if (input.tool !== "edit" && input.tool !== "write") return
    if (client.dbReadyHint() === false) {
      debug("hook.impact", "skipped:", input.tool, "— graph not available")
      return
    }

    try {
      // OpenCode's edit and write tools both schema-validate `filePath`
      // (camelCase) — see opencode/packages/opencode/src/tool/{edit,write}.ts.
      const filePath = input.args?.filePath
      if (!filePath || typeof filePath !== "string") {
        debug("hook.impact", "skipped:", input.tool, "— no filePath in args", Object.keys(input.args ?? {}))
        return
      }

      const impact = await Promise.race([
        client.impact(filePath),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ])
      if (!impact) {
        debug("hook.impact", input.tool, filePath, "— impact returned null or timed out")
        return
      }

      // Skip the append when there's nothing substantive to report.
      // The CLI emits "<--REL--" arrows only when a symbol has at least
      // one dependent; its absence means either the file has no indexed
      // symbols or no indexed callers. Either way the LLM gets no value
      // from the header — it's noise.
      if (!impact.includes("<--")) {
        debug("hook.impact", input.tool, filePath, "— impact has no dependents, skipping header")
        return
      }

      output.output = output.output + "\n\n--- OpenTrace Impact Analysis ---\n" + impact
      debug("hook.impact", input.tool, filePath, "appended", impact.length, "chars")
    } catch (e) {
      debug("hook.impact", "error", e)
    }
  }
}
