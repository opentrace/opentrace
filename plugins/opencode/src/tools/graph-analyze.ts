/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { tool } from "@opencode-ai/plugin"
import type { GraphClient } from "../graph-client.js"

/**
 * Graph hotspots — god nodes and cross-community bridges. Wraps
 * `opentraceai analyze --json`.
 */
export function createGraphAnalyzeTool(client: GraphClient) {
  return tool({
    description: `Summarise the hotspots of the indexed knowledge graph: god nodes (the highest-degree hubs) and edges that cross community boundaries, plus starter questions for exploring them. A good first call on an unfamiliar graph. Run opentrace_graph_build first so community data exists.`,
    args: {
      top: tool.schema.number().optional().describe("Items per category (default 10)."),
    },
    async execute(args) {
      const cliBlocked = await client.requireCliAvailable()
      if (cliBlocked) return cliBlocked

      const subArgs = ["analyze", "--json"]
      if (typeof args.top === "number") subArgs.push("--gods", String(args.top), "--bridges", String(args.top))
      const out = await client.runReadOnly(subArgs, { surfaceErrors: true })
      return out ?? "analyze produced no output (has `opentraceai index` run yet?)"
    },
  })
}
