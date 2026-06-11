/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { tool } from "@opencode-ai/plugin"
import type { GraphClient } from "../graph-client.js"

/**
 * Index a folder and run community detection over the result. Wraps
 * `opentraceai index` followed by `opentraceai cluster`.
 *
 * Clustering needs the graph extra:
 *
 *     uv pip install 'opentraceai[graph]'
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

      const indexOut = await (client as any).run(["index", args.path ?? "."], { surfaceErrors: true })
      const clusterOut = await (client as any).run(["cluster"], { surfaceErrors: true })
      const combined = [indexOut, clusterOut].filter(Boolean).join("\n")
      return combined || "index produced no output"
    },
  })
}
