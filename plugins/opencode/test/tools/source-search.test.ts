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
import { createSourceSearchTool } from "../../src/tools/source-search.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_source_search", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({
      requireDbAvailable: async () => "GATE: db missing",
    })
    const tool = createSourceSearchTool(client)
    const result = await tool.execute({ query: "Foo" } as any, ctx)
    expect(result).toBe("GATE: db missing")
  })

  test("forwards the query verbatim plus a default limit of 20", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      sourceSearchText: async (q, opts) => {
        captured = { q, opts }
        return "[FUNC] foo"
      },
    })
    const tool = createSourceSearchTool(client)
    await tool.execute({ query: "Foo" } as any, ctx)
    expect(captured.q).toBe("Foo")
    expect(captured.opts.limit).toBe(20)
    expect(captured.opts.repo).toBeUndefined()
    expect(captured.opts.nodeTypes).toBeUndefined()
  })

  test("splits node_types on commas, trimming whitespace", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      sourceSearchText: async (_q, opts) => {
        captured = opts
        return ""
      },
    })
    const tool = createSourceSearchTool(client)
    await tool.execute({ query: "x", node_types: "Function, Class ,  Module" } as any, ctx)
    expect(captured.nodeTypes).toEqual(["Function", "Class", "Module"])
  })

  test("forwards repo filter and explicit limit", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      sourceSearchText: async (_q, opts) => {
        captured = opts
        return "ok"
      },
    })
    const tool = createSourceSearchTool(client)
    await tool.execute({ query: "x", repo: "express", limit: 5 } as any, ctx)
    expect(captured.repo).toBe("express")
    expect(captured.limit).toBe(5)
  })

  test("returns a friendly fallback when the CLI returns null", async () => {
    const client = makeGraphClientStub({
      sourceSearchText: async () => null,
    })
    const tool = createSourceSearchTool(client)
    const result = await tool.execute({ query: "MissingThing" } as any, ctx)
    expect(result).toContain('No results found for "MissingThing"')
  })

  test("returns the CLI's text verbatim on success", async () => {
    const client = makeGraphClientStub({
      sourceSearchText: async () => "match\nsecond match",
    })
    const tool = createSourceSearchTool(client)
    const result = await tool.execute({ query: "x" } as any, ctx)
    expect(result).toBe("match\nsecond match")
  })
})
