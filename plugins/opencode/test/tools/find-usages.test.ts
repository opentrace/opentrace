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
import { createFindUsagesTool } from "../../src/tools/find-usages.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_find_usages", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({ requireDbAvailable: async () => "blocked" })
    const result = await createFindUsagesTool(client).execute({ symbol: "x" } as any, ctx)
    expect(result).toBe("blocked")
  })

  test("returns symbol-not-found when ftsSearch comes back empty", async () => {
    const client = makeGraphClientStub({ ftsSearch: async () => [] })
    const result = await createFindUsagesTool(client).execute({ symbol: "Bogus" } as any, ctx)
    expect(result).toContain('Symbol "Bogus" not found')
    expect(result).toContain("opentrace_source_search")
  })

  test("traverses incoming relationships from the best match", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      ftsSearch: async () => [
        { id: "express/lib/router.js::Router", name: "Router", type: "Class" },
      ],
      traverse: async (id, dir, depth) => {
        captured = { id, dir, depth }
        return []
      },
    })
    const findUsages = createFindUsagesTool(client)
    const { tool } = await import("@opencode-ai/plugin")
    const parsed = tool.schema.object(findUsages.args).parse({ symbol: "Router" })
    await findUsages.execute(parsed, ctx)
    expect(captured).toEqual({
      id: "express/lib/router.js::Router",
      dir: "incoming",
      depth: 2,
    })
  })

  test("respects custom depth", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      ftsSearch: async () => [{ id: "r/f.ts::Sym", name: "Sym", type: "Function" }],
      traverse: async (_id, _dir, depth) => {
        captured = depth
        return []
      },
    })
    await createFindUsagesTool(client).execute({ symbol: "x", depth: 4 } as any, ctx)
    expect(captured).toBe(4)
  })

  test("type filter passes through to ftsSearch as a single-element array", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      ftsSearch: async (_q, opts) => {
        captured = opts
        return []
      },
    })
    await createFindUsagesTool(client).execute({ symbol: "x", type: "Function" } as any, ctx)
    expect(captured.nodeTypes).toEqual(["Function"])
  })

  test("reports 'no incoming references' when traverse returns empty", async () => {
    const client = makeGraphClientStub({
      ftsSearch: async () => [{ id: "r/f.ts::Sym", name: "Sym", type: "Function" }],
      traverse: async () => [],
    })
    const result = await createFindUsagesTool(client).execute({ symbol: "Sym" } as any, ctx)
    expect(result).toContain("Usages of [Function] Sym (r):")
    expect(result).toContain("No incoming references")
  })

  test("groups usages by repo with same-repo annotated, then by type, with file:line", async () => {
    const client = makeGraphClientStub({
      ftsSearch: async () => [{ id: "express/lib/router.js::Router", name: "Router", type: "Class" }],
      traverse: async () => [
        {
          node: {
            id: "express/lib/app.js::useRouter",
            name: "useRouter",
            type: "Function",
            properties: { path: "lib/app.js", start_line: 42 },
          },
          relationship: { type: "CALLS", id: "1" },
          depth: 1,
        },
        {
          node: {
            id: "express/lib/app.js::initApp",
            name: "initApp",
            type: "Function",
            properties: { path: "lib/app.js", start_line: 10 },
          },
          relationship: { type: "CALLS", id: "2" },
          depth: 1,
        },
        {
          node: {
            id: "myapp/server.ts::main",
            name: "main",
            type: "Function",
            properties: { path: "server.ts", start_line: 5 },
          },
          relationship: { type: "CALLS", id: "3" },
          depth: 1,
        },
      ],
    })
    const result = await createFindUsagesTool(client).execute({ symbol: "Router" } as any, ctx)
    expect(result).toContain("[express (same repo)]")
    expect(result).toContain("Function (2):")
    expect(result).toContain("- useRouter (lib/app.js:42)")
    expect(result).toContain("- initApp (lib/app.js:10)")
    expect(result).toContain("[myapp]")
    expect(result).toContain("- main (server.ts:5)")
    expect(result).toContain("Total: 3 reference(s) across 2 repo(s)")
  })

  test("falls back to filePathFromNodeId when properties.path is missing", async () => {
    const client = makeGraphClientStub({
      ftsSearch: async () => [{ id: "r/f.ts::Sym", name: "Sym", type: "Function" }],
      traverse: async () => [
        {
          node: {
            id: "r/some/dir/caller.ts::Caller",
            name: "Caller",
            type: "Function",
            properties: {},
          },
          relationship: { type: "CALLS", id: "1" },
          depth: 1,
        },
      ],
    })
    const result = await createFindUsagesTool(client).execute({ symbol: "Sym" } as any, ctx)
    expect(result).toContain("- Caller (some/dir/caller.ts)")
  })

  test("renders properties.path with '?' when start_line is unknown", async () => {
    const client = makeGraphClientStub({
      ftsSearch: async () => [{ id: "r/f.ts::Sym", name: "Sym", type: "Function" }],
      traverse: async () => [
        {
          node: {
            id: "r/x.ts::C",
            name: "C",
            type: "Function",
            properties: { path: "x.ts" },
          },
          relationship: { type: "CALLS", id: "1" },
          depth: 1,
        },
      ],
    })
    const result = await createFindUsagesTool(client).execute({ symbol: "Sym" } as any, ctx)
    expect(result).toContain("- C (x.ts:?)")
  })
})
