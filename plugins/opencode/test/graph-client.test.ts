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

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GraphClient } from "../src/graph-client.js"
import { configureDebug } from "../src/util/debug.js"
import { FakeCli } from "./_helpers/fake-cli.js"

let fake: FakeCli
const savedEnv = { ...process.env }
const FAKE_ENV_KEYS = [
  "FAKE_STDOUT",
  "FAKE_STDOUT_FILE",
  "FAKE_STDERR",
  "FAKE_EXIT",
  "FAKE_SLEEP_MS",
  "FAKE_VERSION_EXIT",
] as const

beforeEach(() => {
  fake = new FakeCli()
  process.env.OPENTRACE_CMD = fake.bin
  fake.configure({ exitCode: 0, stdout: "" })
})

afterEach(() => {
  for (const k of FAKE_ENV_KEYS) delete process.env[k]
  if (savedEnv.OPENTRACE_CMD === undefined) {
    delete process.env.OPENTRACE_CMD
  } else {
    process.env.OPENTRACE_CMD = savedEnv.OPENTRACE_CMD
  }
  try {
    rmSync(fake.dir, { recursive: true, force: true })
  } catch {}
})

async function makeClient(workspaceDir = "/some/dir") {
  configureDebug({ debug: false })
  return await GraphClient.create(workspaceDir, { timeout: 5000, indexTimeout: 5000 })
}

describe("GraphClient.create + isCliAvailable", () => {
  test("when OPENTRACE_CMD probes ok, isCliAvailable() reports true", async () => {
    const client = await makeClient()
    expect(client.isCliAvailable()).toBe(true)
  })

  test("when OPENTRACE_CMD --version exits non-zero, no executable is captured", async () => {
    fake.configure({ versionExitCode: 1 })
    const client = await makeClient()
    expect(client.isCliAvailable()).toBe(false)
  })
})

describe("argument plumbing", () => {
  test("--workspace is injected before the subcommand", async () => {
    fake.configure({ stdout: '{"total_nodes":0,"total_edges":0,"nodes_by_type":{}}' })
    const client = await makeClient("/my/workspace")
    await client.stats()
    const argvs = fake.readSubcommandArgv()
    expect(argvs.length).toBe(1)
    expect(argvs[0]).toEqual(["--workspace", "/my/workspace", "stats", "--output", "json"])
  })

  test("traverse forwards direction, depth, and rel-type flags", async () => {
    fake.configure({ stdout: '{"results":[]}' })
    const client = await makeClient("/w")
    await client.traverse("repo/file.ts::Sym", "incoming", 3, "CALLS")
    const argvs = fake.readSubcommandArgv()
    expect(argvs[0]).toEqual([
      "--workspace",
      "/w",
      "traverse",
      "repo/file.ts::Sym",
      "--direction",
      "incoming",
      "--depth",
      "3",
      "--json",
      "--rel-type",
      "CALLS",
    ])
  })

  test("indexRepo with URL routes to fetch-and-index with --token and --ref", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("https://github.com/foo/bar", "fork", { token: "secret-tok", ref: "develop" })
    const argvs = fake.readSubcommandArgv()
    expect(argvs[0]).toEqual([
      "--workspace",
      "/w",
      "fetch-and-index",
      "https://github.com/foo/bar",
      "--repo-id",
      "fork",
      "--token",
      "secret-tok",
      "--ref",
      "develop",
    ])
  })

  test("indexRepo with local path routes to index (no --token / --ref accepted)", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("/local/repo", undefined, { token: "ignored", ref: "ignored" })
    const argvs = fake.readSubcommandArgv()
    expect(argvs[0]).toEqual(["--workspace", "/w", "index", "/local/repo"])
  })

  test("readSource with nodeId routes via --node-id (no --lines)", async () => {
    fake.configure({ stdout: "// source" })
    const client = await makeClient("/w")
    await client.readSource({ nodeId: "r/f.ts::S" })
    const argvs = fake.readSubcommandArgv()
    expect(argvs[0]).toEqual(["--workspace", "/w", "source-read", "--node-id", "r/f.ts::S"])
  })

  test("readSource with path + both line bounds → closed range", async () => {
    fake.configure({ stdout: "// src" })
    const client = await makeClient("/w")
    await client.readSource({ path: "src/foo.ts", startLine: 5, endLine: 20 })
    expect(fake.readSubcommandArgv()[0]).toEqual([
      "--workspace",
      "/w",
      "source-read",
      "--path",
      "src/foo.ts",
      "--lines",
      "5-20",
    ])
  })

  test("readSource with only startLine → 'N-' open range", async () => {
    fake.configure({ stdout: "//" })
    const client = await makeClient("/w")
    await client.readSource({ path: "src/foo.ts", startLine: 5 })
    expect(fake.readSubcommandArgv()[0]).toEqual([
      "--workspace",
      "/w",
      "source-read",
      "--path",
      "src/foo.ts",
      "--lines",
      "5-",
    ])
  })

  test("readSource with only endLine → '1-N' from-start range", async () => {
    fake.configure({ stdout: "//" })
    const client = await makeClient("/w")
    await client.readSource({ path: "src/foo.ts", endLine: 50 })
    expect(fake.readSubcommandArgv()[0]).toEqual([
      "--workspace",
      "/w",
      "source-read",
      "--path",
      "src/foo.ts",
      "--lines",
      "1-50",
    ])
  })

  test("readSource with neither bound → no --lines flag", async () => {
    fake.configure({ stdout: "//" })
    const client = await makeClient("/w")
    await client.readSource({ path: "src/foo.ts" })
    expect(fake.readSubcommandArgv()[0]).toEqual([
      "--workspace",
      "/w",
      "source-read",
      "--path",
      "src/foo.ts",
    ])
  })
})

describe("exit-code state machine", () => {
  test("exit 3 (DB missing) sets dbReadyHint to false and requireDbAvailable returns the contract message", async () => {
    fake.configure({ exitCode: 3, stderr: "no db" })
    const client = await makeClient()
    const msg = await client.requireDbAvailable()
    expect(msg).toBeTruthy()
    expect(msg).toContain("opentrace_repo_index")
    expect(client.dbReadyHint()).toBe(false)
  })

  test("exit 4 (workspace unresolvable) is sticky and surfaces the workspace-unresolvable message", async () => {
    fake.configure({ exitCode: 4, stderr: "no workspace" })
    const client = await makeClient("/bogus")
    const msg = await client.requireDbAvailable()
    expect(msg).toContain("/bogus")
    expect(client.dbReadyHint()).toBe(false)
  })

  test("exit 0 after a sticky exit 4 does NOT clear _workspaceUnresolvable", async () => {
    fake.configure({ exitCode: 4, stderr: "no workspace" })
    const client = await makeClient("/bogus")
    await client.stats()
    expect(client.dbReadyHint()).toBe(false)

    fake.configure({
      exitCode: 0,
      stdout: '{"total_nodes":1,"total_edges":0,"nodes_by_type":{}}',
    })
    const stats = await client.stats()
    expect(stats?.total_nodes).toBe(1)
    expect(client.dbReadyHint()).toBe(false)
  })

  test("exit 0 after a prior exit 3 clears the dbReady cache to true", async () => {
    fake.configure({ exitCode: 3 })
    const client = await makeClient()
    await client.stats()
    expect(client.dbReadyHint()).toBe(false)
    fake.configure({ exitCode: 0, stdout: '{"total_nodes":1,"total_edges":0,"nodes_by_type":{}}' })
    const stats = await client.stats()
    expect(stats?.total_nodes).toBe(1)
    expect(client.dbReadyHint()).toBe(true)
  })

  test("exit 5 (index in progress) leaves dbReadyHint untouched", async () => {
    fake.configure({ exitCode: 0, stdout: '{"total_nodes":1,"total_edges":0,"nodes_by_type":{}}' })
    const client = await makeClient()
    await client.stats()
    expect(client.dbReadyHint()).toBe(true)

    fake.configure({ exitCode: 5, stderr: "Error: Another index is in progress against /w/.opentrace/index.db" })
    const result = await client.indexRepo("/local/repo")
    expect(result.inProgress).toBe(true)
    expect(client.dbReadyHint()).toBe(true)
  })

  test("requireDbAvailable cold-cache path probes once and caches the result", async () => {
    fake.configure({ exitCode: 0, stdout: '{"total_nodes":0,"total_edges":0,"nodes_by_type":{}}' })
    const client = await makeClient()
    await client.requireDbAvailable()
    expect(client.dbReadyHint()).toBe(true)
    const argvs = fake.readSubcommandArgv()
    expect(argvs[0]).toEqual(["--workspace", "/some/dir", "stats", "--output", "json"])
  })
})

describe("surfaceErrors text branches", () => {
  test("sourceSearchText: non-zero exit returns CLI stderr verbatim", async () => {
    fake.configure({ exitCode: 1, stderr: "No repo with id 'foo'. Available: a, b" })
    const client = await makeClient()
    const text = await client.sourceSearchText("anything", { repo: "foo" })
    expect(text).toContain("No repo with id 'foo'")
    const argvs = fake.readSubcommandArgv()
    expect(argvs[0]).toContain("--repo")
    expect(argvs[0]).toContain("foo")
  })

  test("sourceGrepText: contract exit 3 maps to DB_MISSING_MESSAGE (not the raw CLI text)", async () => {
    fake.configure({ exitCode: 3, stderr: "raw cli message" })
    const client = await makeClient()
    const text = await client.sourceGrepText("pat")
    expect(text).toContain("opentrace_repo_index")
    expect(text).not.toContain("raw cli message")
  })

  test("sourceGrepText: forwards --include and --limit", async () => {
    fake.configure({ stdout: "match" })
    const client = await makeClient("/w")
    await client.sourceGrepText("foo", { include: "*.ts", limit: 10 })
    const argv = fake.readSubcommandArgv()[0]
    expect(argv).toEqual([
      "--workspace",
      "/w",
      "source-grep",
      "foo",
      "--include",
      "*.ts",
      "--limit",
      "10",
    ])
  })
})

describe("JSON parsing helpers", () => {
  test("stats parses well-formed JSON into the typed shape", async () => {
    fake.configure({
      stdout: JSON.stringify({
        total_nodes: 42,
        total_edges: 100,
        nodes_by_type: { Function: 10 },
        metadata: [{ repo_id: "r", node_count: 10 }],
      }),
    })
    const client = await makeClient()
    const stats = await client.stats()
    expect(stats).toEqual({
      total_nodes: 42,
      total_edges: 100,
      nodes_by_type: { Function: 10 },
      metadata: [{ repo_id: "r", node_count: 10 }],
    })
  })

  test("invalid JSON on stdout returns null (logs the parse failure but doesn't throw)", async () => {
    fake.configure({ stdout: "not-json-at-all" })
    const client = await makeClient()
    const stats = await client.stats()
    expect(stats).toBeNull()
  })

  test("stats with empty stdout returns null", async () => {
    fake.configure({ stdout: "" })
    const client = await makeClient()
    expect(await client.stats()).toBeNull()
  })
})

describe("ftsSearch", () => {
  test("argv: query string and FTS mode are forwarded; default has no --limit", async () => {
    fake.configure({ stdout: "[]" })
    const client = await makeClient("/w")
    await client.ftsSearch("Foo")
    const argv = fake.readSubcommandArgv()[0]
    expect(argv).toEqual([
      "--workspace",
      "/w",
      "query",
      "Foo",
      "--type",
      "fts",
      "--output",
      "json",
    ])
  })

  test("argv: explicit limit is forwarded", async () => {
    fake.configure({ stdout: "[]" })
    const client = await makeClient("/w")
    await client.ftsSearch("Foo", { limit: 5 })
    const argv = fake.readSubcommandArgv()[0]
    expect(argv).toContain("--limit")
    expect(argv).toContain("5")
  })

  test("nodeTypes filters the returned nodes", async () => {
    fake.configure({
      stdout: JSON.stringify([
        { id: "r/f.ts::Foo", name: "Foo", type: "Function", properties: {} },
        { id: "r/f.ts::FooClass", name: "FooClass", type: "Class", properties: {} },
        { id: "r/g.ts::FooFile", name: "FooFile", type: "File", properties: {} },
      ]),
    })
    const client = await makeClient()
    const results = await client.ftsSearch("Foo", { nodeTypes: ["Function", "Class"] })
    expect(results.map((r) => r.type).sort()).toEqual(["Class", "Function"])
  })

  test("nodeTypes with a single type returns only that type", async () => {
    fake.configure({
      stdout: JSON.stringify([
        { id: "r/f.ts::Foo", name: "Foo", type: "Function", properties: {} },
        { id: "r/f.ts::FooClass", name: "FooClass", type: "Class", properties: {} },
      ]),
    })
    const client = await makeClient()
    const results = await client.ftsSearch("Foo", { nodeTypes: ["Function"] })
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("Foo")
  })

  test("undefined nodeTypes leaves results unfiltered", async () => {
    fake.configure({
      stdout: JSON.stringify([
        { id: "r/f.ts::Foo", name: "Foo", type: "Function", properties: {} },
        { id: "r/f.ts::FooClass", name: "FooClass", type: "Class", properties: {} },
      ]),
    })
    const client = await makeClient()
    const results = await client.ftsSearch("Foo")
    expect(results).toHaveLength(2)
  })
})

describe("getNode", () => {
  test("normalizes the node and its neighbors", async () => {
    const payload = {
      node: {
        id: "r/f.ts::Foo",
        name: "Foo",
        type: "Function",
        properties: '{"path":"f.ts","start_line":1}',
      },
      neighbors: [
        {
          node: { id: "r/f.ts::Bar", name: "Bar", type: "Function", properties: { path: "f.ts" } },
          relationship: { type: "CALLS", direction: "incoming" },
        },
      ],
    }
    fake.configure({ stdout: JSON.stringify(payload) })
    const client = await makeClient()
    const detail = await client.getNode("r/f.ts::Foo")
    expect(detail!.node.id).toBe("r/f.ts::Foo")
    expect(detail!.node.properties).toEqual({ path: "f.ts", start_line: 1 })
    expect(detail!.neighbors).toHaveLength(1)
    expect(detail!.neighbors[0].relationship.direction).toBe("incoming")
  })

  test("malformed properties string falls through to undefined (best-effort parse)", async () => {
    const payload = {
      node: { id: "r/f.ts", name: "f", type: "File", properties: "not json" },
      neighbors: [],
    }
    fake.configure({ stdout: JSON.stringify(payload) })
    const client = await makeClient()
    const detail = await client.getNode("r/f.ts")
    expect(detail!.node.properties).toBeUndefined()
  })

  test("caps neighbors at the default traverse limit (100)", async () => {
    const neighbors = []
    for (let i = 0; i < 150; i++) {
      neighbors.push({
        node: { id: `r/f.ts::N${i}`, name: `N${i}`, type: "Function", properties: {} },
        relationship: { type: "CALLS", direction: "incoming" },
      })
    }
    fake.configure({
      stdout: JSON.stringify({
        node: { id: "r/f.ts::Foo", name: "Foo", type: "Function" },
        neighbors,
      }),
    })
    const client = await makeClient()
    const detail = await client.getNode("r/f.ts::Foo")
    expect(detail!.neighbors).toHaveLength(100)
  })
})

describe("traverse", () => {
  test("respects opts.limit for slicing", async () => {
    const results = []
    for (let i = 0; i < 50; i++) {
      results.push({
        node: { id: `r/f${i}.ts::N${i}`, name: `N${i}`, type: "Function", properties: {} },
        relationship: { id: `e${i}`, type: "CALLS" },
        depth: 1,
      })
    }
    fake.configure({ stdout: JSON.stringify({ results }) })
    const client = await makeClient()
    const trav = await client.traverse("r/foo.ts::F", "incoming", 1, undefined, { limit: 10 })
    expect(trav).toHaveLength(10)
    expect(trav[0].node.name).toBe("N0")
  })

  test("returns [] on CLI failure (does not throw)", async () => {
    fake.configure({ exitCode: 5, stderr: "store error" })
    const client = await makeClient()
    const trav = await client.traverse("r/foo.ts::F")
    expect(trav).toEqual([])
  })
})

describe("listRepos", () => {
  test("adapts the full repos record into the LLM-visible shape", async () => {
    const records = [
      {
        id: "express",
        name: "Express",
        sourceUri: "https://github.com/expressjs/express",
        branch: "main",
        commitSha: "abc",
        commitMessage: "msg",
        repoPath: "/local/path",
        indexedAt: "2026-01-01",
        durationSeconds: 5,
        nodesCreated: 100,
        relationshipsCreated: 50,
        filesProcessed: 10,
        classesExtracted: 5,
        functionsExtracted: 30,
        opentraceaiVersion: "0.1.0",
      },
    ]
    fake.configure({ stdout: JSON.stringify(records) })
    const client = await makeClient()
    const repos = await client.listRepos()
    expect(repos).toEqual([
      {
        id: "express",
        name: "Express",
        properties: {
          branch: "main",
          sourceUri: "https://github.com/expressjs/express",
          commitSha: "abc",
        },
      },
    ])
    const flat = JSON.stringify(repos)
    expect(flat).not.toContain("commitMessage")
    expect(flat).not.toContain("repoPath")
    expect(flat).not.toContain("indexedAt")
    expect(flat).not.toContain("opentraceaiVersion")
  })

  test("returns [] when CLI returns null (e.g. exit 3 before DB exists)", async () => {
    fake.configure({ exitCode: 3 })
    const client = await makeClient()
    expect(await client.listRepos()).toEqual([])
  })
})

describe("indexRepo result shape", () => {
  test("returns ok=true and the stdout text on exit 0", async () => {
    fake.configure({ stdout: "Indexed 100 nodes" })
    const client = await makeClient()
    const result = await client.indexRepo("/local/repo")
    expect(result).toEqual({ ok: true, message: "Indexed 100 nodes" })
  })

  test("returns ok=false and the stderr on non-zero exit", async () => {
    fake.configure({ exitCode: 1, stderr: "Clone failed: 404" })
    const client = await makeClient()
    const result = await client.indexRepo("https://github.com/foo/bar")
    expect(result.ok).toBe(false)
    expect(result.message).toContain("Clone failed: 404")
  })

  test("exit 3 from the indexer surfaces the contract DB-missing message", async () => {
    fake.configure({ exitCode: 3 })
    const client = await makeClient()
    const result = await client.indexRepo("/local/repo")
    expect(result.ok).toBe(false)
    expect(result.message).toContain("opentrace_repo_index")
  })

  test("exit 5 (single-writer lock held) flags inProgress and uses the LLM-safe message", async () => {
    fake.configure({
      exitCode: 5,
      stderr:
        "Error: Another index is in progress against /w/.opentrace/index.db " +
        "(lock held at /w/.opentrace/index.db.indexlock). Wait for it to finish, " +
        "or remove the lock file if no index is actually running.",
    })
    const client = await makeClient()
    const result = await client.indexRepo("/local/repo")
    expect(result.ok).toBe(false)
    expect(result.inProgress).toBe(true)
    expect(result.message).toContain("Another opentrace_repo_index is currently running")
    // Human-only "remove the lock file" hint must not reach the LLM.
    expect(result.message).not.toContain("remove the lock file")
    expect(result.message).not.toContain("indexlock")
  })

  test("non-lock failures do not set inProgress", async () => {
    fake.configure({ exitCode: 1, stderr: "Clone failed: 404" })
    const client = await makeClient()
    const result = await client.indexRepo("https://github.com/foo/bar")
    expect(result.ok).toBe(false)
    expect(result.inProgress).toBeFalsy()
  })

  test("inProgress flows through the URL (fetch-and-index) variant too", async () => {
    fake.configure({
      exitCode: 5,
      stderr: "Error: Another index is in progress against /w/.opentrace/index.db",
    })
    const client = await makeClient()
    const result = await client.indexRepo("https://github.com/foo/bar")
    expect(result.ok).toBe(false)
    expect(result.inProgress).toBe(true)
    expect(result.message).toContain("Another opentrace_repo_index")
  })

  test("falls back to a synthetic success message when stdout is empty", async () => {
    fake.configure({ exitCode: 0, stdout: "" })
    const client = await makeClient()
    const result = await client.indexRepo("/local/repo")
    expect(result).toEqual({ ok: true, message: "Indexing completed" })
  })
})

describe("timeouts", () => {
  test("a hung subprocess is killed at the per-call timeout", async () => {
    fake.configure({ sleepMs: 5_000 })
    const client = await GraphClient.create("/w", { timeout: 500, indexTimeout: 5000 })
    const start = Date.now()
    const stats = await client.stats()
    const elapsed = Date.now() - start
    expect(stats).toBeNull()
    expect(elapsed).toBeLessThan(2_500)
  }, 10_000)

  test("indexRepo with indexTimeout=0 means 'no timeout' — the CLI runs to completion", async () => {
    fake.configure({ sleepMs: 200, stdout: "Done" })
    const client = await GraphClient.create("/w", { timeout: 50, indexTimeout: 0 })
    const result = await client.indexRepo("/local/repo")
    expect(result).toEqual({ ok: true, message: "Done" })
  }, 10_000)
})

describe("singleflight + probe throttle", () => {
  test("requireDbAvailable: concurrent cold-cache callers share one stats probe", async () => {
    fake.configure({
      exitCode: 0,
      stdout: '{"total_nodes":0,"total_edges":0,"nodes_by_type":{}}',
      sleepMs: 200,
    })
    const client = await makeClient()
    const [a, b] = await Promise.all([client.requireDbAvailable(), client.requireDbAvailable()])
    expect(a).toBeNull()
    expect(b).toBeNull()
    const argvs = fake.readSubcommandArgv()
    const statsCalls = argvs.filter((a) => a.includes("stats"))
    expect(statsCalls).toHaveLength(1)
  }, 10_000)

  test("ensureCli: a failed probe is not re-spawned within the throttle window", async () => {
    fake.configure({ versionExitCode: 1 })
    const client = await makeClient()
    expect(client.isCliAvailable()).toBe(false)
    expect(fake.readArgvLog().filter((a) => a[0] === "--version")).toHaveLength(1)

    const ok1 = await client.ensureCli()
    expect(ok1).toBe(false)
    const callsAfterFirst = fake.readArgvLog().filter((a) => a[0] === "--version").length
    expect(callsAfterFirst).toBe(2)

    const ok2 = await client.ensureCli()
    expect(ok2).toBe(false)
    const callsAfterSecond = fake.readArgvLog().filter((a) => a[0] === "--version").length
    expect(callsAfterSecond).toBe(callsAfterFirst)
  })

  test("ensureCli: parallel probes after a failed create() share one --version subprocess", async () => {
    fake.configure({ versionExitCode: 1 })
    const client = await makeClient()
    expect(client.isCliAvailable()).toBe(false)
    const callsBefore = fake.readArgvLog().filter((a) => a[0] === "--version").length

    fake.configure({ versionExitCode: 0 })
    const [a, b] = await Promise.all([client.ensureCli(), client.ensureCli()])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(client.isCliAvailable()).toBe(true)

    const callsAfter = fake.readArgvLog().filter((a) => a[0] === "--version").length
    expect(callsAfter - callsBefore).toBe(1)
  })
})

describe("token redaction in debug logs", () => {
  test("--token value is replaced with *** in the debug log", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "opentrace-redact-"))
    const debugFile = join(tmp, "debug.log")
    try {
      fake.configure({ exitCode: 1, stderr: "boom" })
      const client = await makeClient()
      configureDebug({ debug: true, debugFile })
      await client.indexRepo("https://github.com/foo/bar", undefined, { token: "SUPER_SECRET_TOKEN" })

      const log = await Bun.file(debugFile).text()
      expect(log).toContain("--token")
      expect(log).toContain("***")
      expect(log).not.toContain("SUPER_SECRET_TOKEN")
    } finally {
      configureDebug({ debug: false })
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {}
    }
  })
})

describe("indexRepo URL detection", () => {
  test("https URL → fetch-and-index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("https://github.com/foo/bar")
    expect(fake.readSubcommandArgv()[0][2]).toBe("fetch-and-index")
  })

  test("http URL → fetch-and-index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("http://internal-git.example.com/foo/bar")
    expect(fake.readSubcommandArgv()[0][2]).toBe("fetch-and-index")
  })

  test("ssh:// URL → fetch-and-index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("ssh://git@github.com/foo/bar.git")
    expect(fake.readSubcommandArgv()[0][2]).toBe("fetch-and-index")
  })

  test("git:// URL → fetch-and-index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("git://example.com/foo/bar.git")
    expect(fake.readSubcommandArgv()[0][2]).toBe("fetch-and-index")
  })

  test("git+ssh:// URL → fetch-and-index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("git+ssh://git@host.example.com/foo/bar.git")
    expect(fake.readSubcommandArgv()[0][2]).toBe("fetch-and-index")
  })

  test("SCP-like git@host:path → fetch-and-index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("git@github.com:foo/bar.git")
    expect(fake.readSubcommandArgv()[0][2]).toBe("fetch-and-index")
  })

  test("bare local path → index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("/local/repo")
    expect(fake.readSubcommandArgv()[0][2]).toBe("index")
  })

  test("relative local path → index", async () => {
    fake.configure({ stdout: "OK" })
    const client = await makeClient("/w")
    await client.indexRepo("./vendor/lib")
    expect(fake.readSubcommandArgv()[0][2]).toBe("index")
  })
})

describe("exit-code state machine — non-contract codes", () => {
  test("non-contract exit (e.g. 1) leaves dbReady cache unchanged", async () => {
    fake.configure({
      exitCode: 0,
      stdout: '{"total_nodes":1,"total_edges":0,"nodes_by_type":{}}',
    })
    const client = await makeClient()
    await client.stats()
    expect(client.dbReadyHint()).toBe(true)

    fake.configure({ exitCode: 1, stderr: "transient" })
    expect(await client.stats()).toBeNull()
    expect(client.dbReadyHint()).toBe(true)
  })

  test("non-contract exit on a cold cache leaves dbReady=null (still 'unknown')", async () => {
    fake.configure({ exitCode: 1, stderr: "transient" })
    const client = await makeClient()
    expect(await client.stats()).toBeNull()
    expect(client.dbReadyHint()).toBeNull()
  })
})

describe("ftsSearch — nodeTypes without an explicit limit", () => {
  test("post-filter applies; no --limit flag is forwarded to the CLI", async () => {
    fake.configure({
      stdout: JSON.stringify([
        { id: "r/a.ts::A", name: "A", type: "Function", properties: {} },
        { id: "r/b.ts::B", name: "B", type: "Class", properties: {} },
        { id: "r/c.ts::C", name: "C", type: "Function", properties: {} },
      ]),
    })
    const client = await makeClient("/w")
    const results = await client.ftsSearch("X", { nodeTypes: ["Function"] })
    expect(results.map((r) => r.id).sort()).toEqual(["r/a.ts::A", "r/c.ts::C"])
    const argv = fake.readSubcommandArgv()[0]
    expect(argv).not.toContain("--limit")
  })
})
