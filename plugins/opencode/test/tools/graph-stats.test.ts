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
import { createGraphStatsTool } from "../../src/tools/graph-stats.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

const ctx: any = { sessionID: "s", messageID: "m", agent: "a", directory: "/", worktree: "/", abort: new AbortController().signal, metadata: () => {}, ask: () => {} }

describe("opentrace_graph_stats", () => {
  test("returns the gate's blocked message when DB is unavailable", async () => {
    const client = makeGraphClientStub({ requireDbAvailable: async () => "blocked" })
    const result = await createGraphStatsTool(client).execute({} as any, ctx)
    expect(result).toBe("blocked")
  })

  test("returns failure message when stats() returns null", async () => {
    const client = makeGraphClientStub({ stats: async () => null })
    const result = await createGraphStatsTool(client).execute({} as any, ctx)
    expect(result).toContain("Failed to retrieve graph statistics")
  })

  test("renders totals + node-by-type sorted desc + indexed repos", async () => {
    const client = makeGraphClientStub({
      stats: async () => ({
        total_nodes: 100,
        total_edges: 250,
        nodes_by_type: { Class: 5, Function: 80, File: 15 },
      }),
      listRepos: async () => [
        { id: "express", name: "express", properties: { branch: "main", sourceUri: "https://github.com/expressjs/express", commitSha: "abc" } },
        { id: "react", name: "React", properties: { branch: null, sourceUri: null, commitSha: null } },
      ],
    })
    const result = await createGraphStatsTool(client).execute({} as any, ctx)
    expect(result).toContain("Total nodes: 100")
    expect(result).toContain("Total edges: 250")
    expect(typeof result).toBe("string")
    const text = result as string
    const fnPos = text.indexOf("Function: 80")
    const filePos = text.indexOf("File: 15")
    const classPos = text.indexOf("Class: 5")
    expect(fnPos).toBeGreaterThan(-1)
    expect(filePos).toBeGreaterThan(fnPos)
    expect(classPos).toBeGreaterThan(filePos)
    expect(result).toContain("Indexed repositories (2):")
    expect(result).toContain("- express [main] (https://github.com/expressjs/express)")
    expect(result).toContain("- React")
  })

  test("omits the nodes-by-type section when empty", async () => {
    const client = makeGraphClientStub({
      stats: async () => ({ total_nodes: 0, total_edges: 0, nodes_by_type: {} }),
      listRepos: async () => [],
    })
    const result = await createGraphStatsTool(client).execute({} as any, ctx)
    expect(result).not.toContain("Nodes by type")
    expect(result).not.toContain("Indexed repositories")
  })
})
