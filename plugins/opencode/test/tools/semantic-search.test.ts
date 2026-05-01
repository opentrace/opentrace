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

import { describe, expect, test } from "bun:test"
import { createSemanticSearchTool } from "../../src/tools/semantic-search.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_semantic_search", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({
      requireDbAvailable: async () => "DB MISSING",
    })
    const result = await createSemanticSearchTool(client).execute({ query: "x" } as any, ctx)
    expect(result).toBe("DB MISSING")
  })

  test("default limit is 10 (smaller than source-search's 20)", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      ftsSearch: async (_q, opts) => {
        captured = opts
        return []
      },
    })
    await createSemanticSearchTool(client).execute({ query: "x" } as any, ctx)
    expect(captured.limit).toBe(10)
  })

  test("returns a fallback that suggests source-search when FTS finds nothing", async () => {
    const client = makeGraphClientStub({ ftsSearch: async () => [] })
    const result = await createSemanticSearchTool(client).execute({ query: "missing" } as any, ctx)
    expect(result).toContain("No results")
    expect(result).toContain("opentrace_source_search")
  })

  test("renders results with repo, file, lines, signature, summary, docs, node id", async () => {
    const client = makeGraphClientStub({
      ftsSearch: async () => [
        {
          id: "express/lib/router.js::Router",
          name: "Router",
          type: "Class",
          properties: {
            path: "lib/router.js",
            start_line: 10,
            end_line: 50,
            signature: "class Router",
            summary: "Express router",
            docs: "Routes HTTP requests",
          },
        },
      ],
    })
    const result = await createSemanticSearchTool(client).execute({ query: "router" } as any, ctx)
    expect(result).toContain("[Class] Router")
    expect(result).toContain("Repo: express")
    expect(result).toContain("File: lib/router.js")
    expect(result).toContain("Lines: 10-50")
    expect(result).toContain("Signature: class Router")
    expect(result).toContain("Summary: Express router")
    expect(result).toContain("Docs: Routes HTTP requests")
    expect(result).toContain("Node ID: express/lib/router.js::Router")
    expect(result).toContain("opentrace_source_read")
  })

  test("end_line=null shows '?' to flag unknown range", async () => {
    const client = makeGraphClientStub({
      ftsSearch: async () => [
        {
          id: "r/f.ts::Sym",
          name: "Sym",
          type: "Function",
          properties: { start_line: 5, end_line: null },
        },
      ],
    })
    const result = await createSemanticSearchTool(client).execute({ query: "x" } as any, ctx)
    expect(result).toContain("Lines: 5-?")
  })

  test("docs are truncated to 200 chars to keep the LLM payload bounded", async () => {
    const longDocs = "x".repeat(500)
    const client = makeGraphClientStub({
      ftsSearch: async () => [
        {
          id: "r/f.ts::Sym",
          name: "Sym",
          type: "Function",
          properties: { docs: longDocs },
        },
      ],
    })
    const result = await createSemanticSearchTool(client).execute({ query: "x" } as any, ctx)
    expect(result).toContain("Docs: " + "x".repeat(200))
    expect(result).not.toContain("x".repeat(201))
  })

  test("missing optional properties are gracefully omitted", async () => {
    const client = makeGraphClientStub({
      ftsSearch: async () => [
        { id: "r/f.ts", name: "f", type: "File", properties: {} },
      ],
    })
    const result = await createSemanticSearchTool(client).execute({ query: "x" } as any, ctx)
    expect(result).toContain("[File] f")
    expect(result).toContain("Repo: r")
    expect(result).not.toContain("File:")
    expect(result).not.toContain("Lines:")
    expect(result).not.toContain("Signature:")
  })
})
