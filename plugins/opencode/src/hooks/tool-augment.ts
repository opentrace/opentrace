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
 * Hook for tool.execute.after — appends OpenTrace graph context after
 * a grep or glob tool call so the LLM sees matching nodes and their
 * relationships alongside the lexical matches. Runs after execution
 * and appends to the output text (the LLM only sees a tool's output,
 * never its args, so writing to args wouldn't reach the model).
 *
 * Has a 3s timeout so a slow CLI response can't stall the tool reply.
 */
export function createToolAugmentHook(client: GraphClient) {
  return async (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => {
    if (input.tool !== "grep" && input.tool !== "glob") return
    if (client.dbReadyHint() === false) {
      debug("hook.augment", "skipped:", input.tool, "— graph not available")
      return
    }

    try {
      const pattern = input.args?.pattern
      if (!pattern || typeof pattern !== "string") {
        debug("hook.augment", "skipped:", input.tool, "— no pattern in args")
        return
      }

      const context = await Promise.race([
        client.augment(pattern),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ])
      if (!context) {
        debug("hook.augment", input.tool, "pattern=", pattern, "— augment returned null or timed out")
        return
      }

      output.output = output.output + "\n\n--- OpenTrace Graph Context ---\n" + context
      debug("hook.augment", input.tool, "pattern=", pattern, "appended", context.length, "chars")
    } catch (e) {
      debug("hook.augment", "error", e)
    }
  }
}
