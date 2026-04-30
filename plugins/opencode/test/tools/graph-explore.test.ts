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
import { createGraphExploreTool } from "../../src/tools/graph-explore.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_graph_explore", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({ requireDbAvailable: async () => "blocked" })
    const result = await createGraphExploreTool(client).execute({} as any, ctx)
    expect(result).toBe("blocked")
  })

  test("requires either node_id or name", async () => {
    const client = makeGraphClientStub()
    const result = await createGraphExploreTool(client).execute({} as any, ctx)
    expect(result).toContain("provide either a node_id")
  })

  test("by name: searches and resolves to the first hit's id", async () => {
    let searched: any = null
    const captured: { fetched: string | null } = { fetched: null }
    const client = makeGraphClientStub({
      ftsSearch: async (q, opts) => {
        searched = { q, opts }
        return [{ id: "r/f.ts::Sym", name: "Sym", type: "Function" }]
      },
      getNode: async (id) => {
        captured.fetched = id
        return null
      },
    })
    await createGraphExploreTool(client).execute({ name: "Sym", type: "Function" } as any, ctx)
    expect(searched.q).toBe("Sym")
    expect(searched.opts.nodeTypes).toEqual(["Function"])
    expect(searched.opts.limit).toBe(1)
    expect(captured.fetched).toBe("r/f.ts::Sym")
  })

  test("name search miss returns 'not found' with a hint", async () => {
    const client = makeGraphClientStub({ ftsSearch: async () => [] })
    const result = await createGraphExploreTool(client).execute({ name: "missing" } as any, ctx)
    expect(result).toContain('Node "missing" not found')
    expect(result).toContain("opentrace_source_search")
  })

  test("getNode miss returns 'not found in the graph'", async () => {
    const client = makeGraphClientStub({ getNode: async () => null })
    const result = await createGraphExploreTool(client).execute({ node_id: "ghost" } as any, ctx)
    expect(result).toContain("Node ghost not found in the graph")
  })

  test("renders node header + properties + grouped neighbor relationships", async () => {
    const client = makeGraphClientStub({
      getNode: async () => ({
        node: {
          id: "express/lib/router.js::Router",
          name: "Router",
          type: "Class",
          properties: {
            path: "lib/router.js",
            start_line: 10,
            end_line: 50,
            signature: "class Router",
            language: "javascript",
            docs: "Router docstring",
            summary: "router summary",
          },
        },
        neighbors: [
          {
            node: { id: "express/lib/app.js::App", name: "App", type: "Class" },
            relationship: { type: "CALLS", direction: "incoming" },
          },
          {
            node: { id: "express/lib/utils.js::parse", name: "parse", type: "Function" },
            relationship: { type: "USES", direction: "outgoing" },
          },
        ],
      }),
    })
    const result = await createGraphExploreTool(client).execute(
      { node_id: "express/lib/router.js::Router" } as any,
      ctx,
    )
    expect(result).toContain("[Class] Router")
    expect(result).toContain("Repo: express")
    expect(result).toContain("ID: express/lib/router.js::Router")
    expect(result).toContain("File: lib/router.js")
    expect(result).toContain("Lines: 10-50")
    expect(result).toContain("Signature: class Router")
    expect(result).toContain("Language: javascript")
    expect(result).toContain("Docs: Router docstring")
    expect(result).toContain("Summary: router summary")
    expect(result).toContain("Outgoing relationships (1):")
    expect(result).toContain("--USES--> [Function] parse")
    expect(result).toContain("Incoming relationships (1):")
    expect(result).toContain("<--CALLS-- [Class] App")
  })

  test("truncates each direction's neighbor list to 20 with a '... and N more' tail", async () => {
    type Neighbor = {
      node: { id: string; name: string; type: string }
      relationship: { type: string; direction: "incoming" | "outgoing" }
    }
    const neighbors: Neighbor[] = []
    for (let i = 0; i < 25; i++) {
      neighbors.push({
        node: { id: `r/f${i}.ts::N${i}`, name: `N${i}`, type: "Function" },
        relationship: { type: "CALLS", direction: "outgoing" },
      })
    }
    const client = makeGraphClientStub({
      getNode: async () => ({
        node: { id: "r/main.ts::Main", name: "Main", type: "Function" },
        neighbors,
      }),
    })
    const result = await createGraphExploreTool(client).execute({ node_id: "r/main.ts::Main" } as any, ctx)
    expect(result).toContain("Outgoing relationships (25):")
    expect(result).toContain("[Function] N0")
    expect(result).toContain("[Function] N19")
    expect(result).not.toContain("[Function] N20")
    expect(result).toContain("... and 5 more")
  })

  test("'No relationships found' when neighbors is empty", async () => {
    const client = makeGraphClientStub({
      getNode: async () => ({
        node: { id: "r/x.ts::Foo", name: "Foo", type: "Function" },
        neighbors: [],
      }),
    })
    const result = await createGraphExploreTool(client).execute({ node_id: "r/x.ts::Foo" } as any, ctx)
    expect(result).toContain("No relationships found")
  })

  test("docs are truncated to 300 chars in the explore view", async () => {
    const longDocs = "x".repeat(500)
    const client = makeGraphClientStub({
      getNode: async () => ({
        node: { id: "r/f.ts::S", name: "S", type: "Function", properties: { docs: longDocs } },
        neighbors: [],
      }),
    })
    const result = await createGraphExploreTool(client).execute({ node_id: "r/f.ts::S" } as any, ctx)
    expect(result).toContain("Docs: " + "x".repeat(300))
    expect(result).not.toContain("x".repeat(301))
  })
})
