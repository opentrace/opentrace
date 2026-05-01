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
import { createSourceGrepTool } from "../../src/tools/source-grep.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_source_grep", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({ requireDbAvailable: async () => "blocked" })
    const result = await createSourceGrepTool(client).execute({ pattern: "foo" } as any, ctx)
    expect(result).toBe("blocked")
  })

  test("forwards pattern + default limit of 50 to sourceGrepText", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      sourceGrepText: async (p, opts) => {
        captured = { p, opts }
        return "match"
      },
    })
    await createSourceGrepTool(client).execute({ pattern: "TODO" } as any, ctx)
    expect(captured.p).toBe("TODO")
    expect(captured.opts.limit).toBe(50)
  })

  test("forwards optional repo and include filters", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      sourceGrepText: async (_p, opts) => {
        captured = opts
        return "ok"
      },
    })
    await createSourceGrepTool(client).execute(
      { pattern: "foo", repo: "express", include: "*.ts", limit: 5 } as any,
      ctx,
    )
    expect(captured.repo).toBe("express")
    expect(captured.include).toBe("*.ts")
    expect(captured.limit).toBe(5)
  })

  test("returns CLI text verbatim", async () => {
    const client = makeGraphClientStub({
      sourceGrepText: async () => "src/foo.ts:10:match",
    })
    const result = await createSourceGrepTool(client).execute({ pattern: "x" } as any, ctx)
    expect(result).toBe("src/foo.ts:10:match")
  })

  test("returns a friendly fallback when the CLI returns null", async () => {
    const client = makeGraphClientStub({ sourceGrepText: async () => null })
    const result = await createSourceGrepTool(client).execute({ pattern: "ZZZ" } as any, ctx)
    expect(result).toContain('No matches for "ZZZ"')
  })
})
