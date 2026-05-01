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
import { createSourceReadTool } from "../../src/tools/source-read.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_source_read", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({ requireDbAvailable: async () => "no db" })
    const result = await createSourceReadTool(client).execute({} as any, ctx)
    expect(result).toBe("no db")
  })

  test("requires either node_id or path", async () => {
    const client = makeGraphClientStub()
    const result = await createSourceReadTool(client).execute({} as any, ctx)
    expect(result).toContain("provide either a node_id")
  })

  test("forwards node_id as { nodeId } to readSource", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      readSource: async (opts) => {
        captured = opts
        return "// source"
      },
    })
    await createSourceReadTool(client).execute({ node_id: "repo/foo.ts::Bar" } as any, ctx)
    expect(captured).toEqual({ nodeId: "repo/foo.ts::Bar" })
  })

  test("forwards path with start_line / end_line", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      readSource: async (opts) => {
        captured = opts
        return "src"
      },
    })
    await createSourceReadTool(client).execute(
      { path: "src/foo.ts", start_line: 5, end_line: 20 } as any,
      ctx,
    )
    expect(captured).toEqual({ path: "src/foo.ts", startLine: 5, endLine: 20 })
  })

  test("path-only call passes undefined start/end so CLI reads the whole file", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      readSource: async (opts) => {
        captured = opts
        return "src"
      },
    })
    await createSourceReadTool(client).execute({ path: "src/foo.ts" } as any, ctx)
    expect(captured).toEqual({ path: "src/foo.ts", startLine: undefined, endLine: undefined })
  })

  test("when both node_id and path are provided, node_id wins", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      readSource: async (opts) => {
        captured = opts
        return "ok"
      },
    })
    await createSourceReadTool(client).execute(
      { node_id: "r/f.ts::Sym", path: "irrelevant.ts" } as any,
      ctx,
    )
    expect(captured).toEqual({ nodeId: "r/f.ts::Sym" })
  })

  test("returns the CLI's text on success", async () => {
    const client = makeGraphClientStub({ readSource: async () => "// some\n// code" })
    const result = await createSourceReadTool(client).execute({ node_id: "x" } as any, ctx)
    expect(result).toBe("// some\n// code")
  })

  test("returns the file-not-available fallback when readSource returns null", async () => {
    const client = makeGraphClientStub({ readSource: async () => null })
    const result = await createSourceReadTool(client).execute({ path: "src/foo.ts" } as any, ctx)
    expect(result).toContain("Could not read source")
    expect(result).toContain("cloned")
  })
})
