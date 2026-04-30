/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { describe, expect, test } from "bun:test"
import { createImpactAnalysisTool } from "../../src/tools/impact-analysis.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_impact_analysis", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({ requireDbAvailable: async () => "blocked" })
    const result = await createImpactAnalysisTool(client).execute({ target: "x" } as any, ctx)
    expect(result).toBe("blocked")
  })

  test("forwards the target and optional lines to client.impact", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      impact: async (target, lines) => {
        captured = { target, lines }
        return "<-- something"
      },
    })
    await createImpactAnalysisTool(client).execute(
      { target: "src/foo.ts", lines: "10-25,40-60" } as any,
      ctx,
    )
    expect(captured).toEqual({ target: "src/foo.ts", lines: "10-25,40-60" })
  })

  test("returns CLI text on success", async () => {
    const client = makeGraphClientStub({ impact: async () => "src/foo.ts <-- src/bar.ts" })
    const result = await createImpactAnalysisTool(client).execute({ target: "src/foo.ts" } as any, ctx)
    expect(result).toBe("src/foo.ts <-- src/bar.ts")
  })

  test("returns a friendly fallback when impact returns null", async () => {
    const client = makeGraphClientStub({ impact: async () => null })
    const result = await createImpactAnalysisTool(client).execute({ target: "missing" } as any, ctx)
    expect(result).toContain('No impact data found for "missing"')
    expect(result).toContain("opentrace_source_search")
  })
})
