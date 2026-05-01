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
import type { GraphStats } from "../../src/graph-client.js"
import { buildSystemPrompt } from "../../src/hooks/system-prompt.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

describe("buildSystemPrompt", () => {
  test("static core is always emitted, regardless of CLI/DB state", async () => {
    const client = makeGraphClientStub({
      isCliAvailable: () => false,
      dbReadyHint: () => false,
    })
    const result = await buildSystemPrompt(client)
    expect(result.text).toContain("OpenTrace Knowledge Graph")
    expect(result.text).toContain("Tool selection guide")
    expect(result.text).toContain("opentrace_source_search")
    expect(result.text).toContain("opentrace_source_read")
    expect(result.text).toContain("opentrace_repo_index")
  })

  test("static-only output sets hasAppendix=false (callers must NOT cache)", async () => {
    const client = makeGraphClientStub({
      isCliAvailable: () => false,
      dbReadyHint: () => false,
    })
    const result = await buildSystemPrompt(client)
    expect(result.hasAppendix).toBe(false)
    expect(result.text).not.toContain("Current state")
  })

  test("appendix omitted when CLI is available but DB is missing (dbReadyHint=false)", async () => {
    const client = makeGraphClientStub({
      isCliAvailable: () => true,
      dbReadyHint: () => false,
      stats: async () => ({
        total_nodes: 1,
        total_edges: 1,
        nodes_by_type: { Function: 1 },
      }),
    })
    const result = await buildSystemPrompt(client)
    expect(result.hasAppendix).toBe(false)
    expect(result.text).not.toContain("Current state")
  })

  test("appendix omitted when stats returns null (CLI returned non-zero or parse failed)", async () => {
    const client = makeGraphClientStub({
      isCliAvailable: () => true,
      dbReadyHint: () => null,
      stats: async () => null,
    })
    const result = await buildSystemPrompt(client)
    expect(result.hasAppendix).toBe(false)
    expect(result.text).not.toContain("Current state")
  })

  test("appendix renders node/edge counts and top-N node types", async () => {
    const stats: GraphStats = {
      total_nodes: 1234,
      total_edges: 5678,
      nodes_by_type: {
        Function: 800,
        Class: 200,
        Module: 150,
        File: 84,
      },
    }
    const client = makeGraphClientStub({
      isCliAvailable: () => true,
      dbReadyHint: () => true,
      stats: async () => stats,
    })
    const result = await buildSystemPrompt(client)
    expect(result.hasAppendix).toBe(true)
    expect(result.text).toContain("Current state")
    expect(result.text).toContain("1234 nodes and 5678 edges")
    const functionPos = result.text.indexOf("800 Function")
    const classPos = result.text.indexOf("200 Class")
    expect(functionPos).toBeGreaterThan(-1)
    expect(classPos).toBeGreaterThan(functionPos)
  })

  test("appendix lists indexed repos with ids the LLM can pass to --repo", async () => {
    const client = makeGraphClientStub({
      isCliAvailable: () => true,
      dbReadyHint: () => true,
      stats: async () => ({ total_nodes: 1, total_edges: 1, nodes_by_type: {} }),
      listRepos: async () => [
        { id: "express", name: "express", properties: { branch: "main", sourceUri: "https://github.com/expressjs/express", commitSha: "abc" } },
        { id: "react", name: "React", properties: { branch: null, sourceUri: null, commitSha: null } },
      ],
    })
    const result = await buildSystemPrompt(client)
    expect(result.text).toContain("Indexed repositories")
    expect(result.text).toContain("- express")
    expect(result.text).toContain("[main]")
    expect(result.text).toContain("- react (React)")
  })

  test("appendix omits the repos block when listRepos returns empty", async () => {
    const client = makeGraphClientStub({
      isCliAvailable: () => true,
      dbReadyHint: () => true,
      stats: async () => ({ total_nodes: 0, total_edges: 0, nodes_by_type: {} }),
      listRepos: async () => [],
    })
    const result = await buildSystemPrompt(client)
    expect(result.hasAppendix).toBe(true)
    expect(result.text).not.toContain("Indexed repositories")
  })
})
