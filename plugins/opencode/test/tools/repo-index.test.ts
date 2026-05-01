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
import { createRepoIndexTool } from "../../src/tools/repo-index.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

function makeCtx() {
  const titles: string[] = []
  return {
    ctx: {
      sessionID: "s",
      messageID: "m",
      agent: "a",
      directory: "/",
      worktree: "/",
      abort: new AbortController().signal,
      metadata: (m: { title?: string }) => {
        if (m.title) titles.push(m.title)
      },
      ask: () => {},
    } as any,
    titles,
  }
}

describe("opentrace_repo_index", () => {
  test("uses requireCliAvailable (NOT requireDbAvailable) — first-run can index without an existing DB", async () => {
    let calledDb = false
    let calledCli = false
    const client = makeGraphClientStub({
      requireDbAvailable: async () => {
        calledDb = true
        return null
      },
      requireCliAvailable: async () => {
        calledCli = true
        return null
      },
      indexRepo: async () => ({ ok: true, message: "Indexed 100 nodes" }),
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx } = makeCtx()
    await tool.execute({ path_or_url: "/path/to/repo" } as any, ctx)
    expect(calledCli).toBe(true)
    expect(calledDb).toBe(false)
  })

  test("returns the gate's blocked message when CLI is unavailable", async () => {
    const client = makeGraphClientStub({
      requireCliAvailable: async () => "no cli",
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx } = makeCtx()
    const result = await tool.execute({ path_or_url: "/p" } as any, ctx)
    expect(result).toBe("no cli")
  })

  test("dedupe by repo_id matching existing repo's id", async () => {
    let indexCalled = false
    const client = makeGraphClientStub({
      listRepos: async () => [
        { id: "express", name: "express", properties: { sourceUri: null, branch: "main", commitSha: "abc" } },
      ],
      indexRepo: async () => {
        indexCalled = true
        return { ok: true, message: "x" }
      },
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx } = makeCtx()
    const result = await tool.execute({ path_or_url: "irrelevant", repo_id: "express" } as any, ctx)
    expect(indexCalled).toBe(false)
    expect(result).toContain("already indexed")
    expect(result).toContain("Branch: main")
  })

  test("dedupe by sourceUri matching path_or_url", async () => {
    let indexCalled = false
    const client = makeGraphClientStub({
      listRepos: async () => [
        {
          id: "express",
          name: "express",
          properties: { sourceUri: "https://github.com/expressjs/express", branch: "main", commitSha: "abc" },
        },
      ],
      indexRepo: async () => {
        indexCalled = true
        return { ok: true, message: "x" }
      },
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx } = makeCtx()
    const result = await tool.execute(
      { path_or_url: "https://github.com/expressjs/express" } as any,
      ctx,
    )
    expect(indexCalled).toBe(false)
    expect(result).toContain("already indexed")
  })

  test("when DB is known to be missing, skips the dedupe call entirely", async () => {
    let listCalled = false
    let indexCalled = false
    const client = makeGraphClientStub({
      dbReadyHint: () => false,
      listRepos: async () => {
        listCalled = true
        return []
      },
      indexRepo: async () => {
        indexCalled = true
        return { ok: true, message: "ok" }
      },
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx } = makeCtx()
    await tool.execute({ path_or_url: "/p" } as any, ctx)
    expect(listCalled).toBe(false)
    expect(indexCalled).toBe(true)
  })

  test("forwards path_or_url, repo_id, ref, and resolved token to indexRepo", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      indexRepo: async (path, id, opts) => {
        captured = { path, id, opts }
        return { ok: true, message: "ok" }
      },
    })
    const tool = createRepoIndexTool(client, async (url) => {
      expect(url).toBe("https://github.com/foo/bar")
      return "TOKEN_VALUE"
    })
    const { ctx } = makeCtx()
    await tool.execute(
      { path_or_url: "https://github.com/foo/bar", repo_id: "bar-fork", ref: "develop" } as any,
      ctx,
    )
    expect(captured).toEqual({
      path: "https://github.com/foo/bar",
      id: "bar-fork",
      opts: { token: "TOKEN_VALUE", ref: "develop" },
    })
  })

  test("undefined token from resolver becomes opts.token === undefined", async () => {
    let captured: any = null
    const client = makeGraphClientStub({
      indexRepo: async (_p, _id, opts) => {
        captured = opts
        return { ok: true, message: "ok" }
      },
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx } = makeCtx()
    await tool.execute({ path_or_url: "/local/path" } as any, ctx)
    expect(captured.token).toBeUndefined()
  })

  test("on success surfaces the CLI message and updates title metadata", async () => {
    const client = makeGraphClientStub({
      indexRepo: async () => ({ ok: true, message: "Indexed 200 nodes" }),
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx, titles } = makeCtx()
    const result = await tool.execute({ path_or_url: "/path/to/myrepo" } as any, ctx)
    expect(result).toContain("Indexing result:")
    expect(result).toContain("Indexed 200 nodes")
    expect(result).toContain("opentrace_source_search")
    expect(titles).toContain("Indexing myrepo...")
    expect(titles).toContain("Indexed myrepo")
  })

  test("dedupe by name === args.repo_id even when id differs", async () => {
    let indexCalled = false
    const client = makeGraphClientStub({
      listRepos: async () => [
        { id: "auto-generated-id-123", name: "myproj", properties: { sourceUri: null, branch: "main", commitSha: "abc" } },
      ],
      indexRepo: async () => {
        indexCalled = true
        return { ok: true, message: "x" }
      },
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx } = makeCtx()
    const result = await tool.execute({ path_or_url: "irrelevant", repo_id: "myproj" } as any, ctx)
    expect(indexCalled).toBe(false)
    expect(result).toContain("already indexed")
    expect(result).toContain("Branch: main")
  })

  test("title metadata strips the .git suffix from URLs", async () => {
    const client = makeGraphClientStub({
      indexRepo: async () => ({ ok: true, message: "ok" }),
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx, titles } = makeCtx()
    await tool.execute({ path_or_url: "https://github.com/foo/bar.git" } as any, ctx)
    expect(titles).toContain("Indexing bar...")
    expect(titles).toContain("Indexed bar")
    expect(titles.some((t) => t.includes(".git"))).toBe(false)
  })

  test("trailing slash in path_or_url falls back to a non-empty title name", async () => {
    const client = makeGraphClientStub({
      indexRepo: async () => ({ ok: true, message: "ok" }),
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx, titles } = makeCtx()
    await tool.execute({ path_or_url: "/path/to/repo/" } as any, ctx)
    expect(titles[0]).not.toMatch(/^Indexing\s*\.\.\.$/)
    expect(titles[0]).not.toBe("Indexing ...")
  })

  test("on indexer failure surfaces the error and updates title to a failure", async () => {
    const client = makeGraphClientStub({
      indexRepo: async () => ({ ok: false, message: "Clone failed: 404" }),
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx, titles } = makeCtx()
    const result = await tool.execute(
      { path_or_url: "https://github.com/foo/missing.git" } as any,
      ctx,
    )
    expect(result).toContain("Indexing failed")
    expect(result).toContain("Clone failed: 404")
    expect(titles).toContain("Indexing missing failed")
  })

  test("inProgress lock failure: distinct title, message returned verbatim (no 'Indexing failed' prefix)", async () => {
    const lockMsg =
      "Another opentrace_repo_index is currently running in this workspace. " +
      "Wait a few minutes and try again, or use the existing graph via the " +
      "other opentrace_ tools in the meantime."
    const client = makeGraphClientStub({
      indexRepo: async () => ({ ok: false, message: lockMsg, inProgress: true }),
    })
    const tool = createRepoIndexTool(client, async () => null)
    const { ctx, titles } = makeCtx()
    const result = await tool.execute(
      { path_or_url: "/path/to/myrepo" } as any,
      ctx,
    )
    expect(result).toBe(lockMsg)
    expect(result).not.toContain("Indexing failed")
    expect(titles).toContain("Waiting on another index...")
    expect(titles).not.toContain("Indexing myrepo failed")
  })
})
