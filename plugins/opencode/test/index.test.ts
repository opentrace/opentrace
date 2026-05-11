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
import { rmSync } from "node:fs"
import opentracePlugin, { OpentracePluginOptionsSchema } from "../src/index.js"
import { configureDebug } from "../src/util/debug.js"
import { FakeCli } from "./_helpers/fake-cli.js"

describe("OpentracePluginOptionsSchema", () => {
  test("accepts an empty object (all options optional)", () => {
    const r = OpentracePluginOptionsSchema.safeParse({})
    expect(r.success).toBe(true)
  })

  test("accepts a fully-specified options object", () => {
    const r = OpentracePluginOptionsSchema.safeParse({
      timeout: 5000,
      indexTimeout: 60_000,
      debug: true,
      debugFile: "/tmp/opentrace.log",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.timeout).toBe(5000)
      expect(r.data.indexTimeout).toBe(60_000)
      expect(r.data.debug).toBe(true)
      expect(r.data.debugFile).toBe("/tmp/opentrace.log")
    }
  })

  test("rejects unknown keys (strict mode catches typos)", () => {
    const r = OpentracePluginOptionsSchema.safeParse({ tiemout: 5000 })
    expect(r.success).toBe(false)
  })

  test("rejects non-positive timeout values", () => {
    expect(OpentracePluginOptionsSchema.safeParse({ timeout: 0 }).success).toBe(false)
    expect(OpentracePluginOptionsSchema.safeParse({ timeout: -1 }).success).toBe(false)
  })

  test("rejects non-integer timeout values", () => {
    expect(OpentracePluginOptionsSchema.safeParse({ timeout: 1.5 }).success).toBe(false)
  })

  test("indexTimeout 0 is permitted (means no-timeout)", () => {
    const r = OpentracePluginOptionsSchema.safeParse({ indexTimeout: 0 })
    expect(r.success).toBe(true)
  })

  test("indexTimeout cannot be negative", () => {
    expect(OpentracePluginOptionsSchema.safeParse({ indexTimeout: -1 }).success).toBe(false)
  })

  test("debug must be a boolean if provided", () => {
    expect(OpentracePluginOptionsSchema.safeParse({ debug: "true" as any }).success).toBe(false)
    expect(OpentracePluginOptionsSchema.safeParse({ debug: 1 as any }).success).toBe(false)
    expect(OpentracePluginOptionsSchema.safeParse({ debug: true }).success).toBe(true)
    expect(OpentracePluginOptionsSchema.safeParse({ debug: false }).success).toBe(true)
  })

  test("debugFile must be a non-empty string", () => {
    expect(OpentracePluginOptionsSchema.safeParse({ debugFile: "" }).success).toBe(false)
    expect(OpentracePluginOptionsSchema.safeParse({ debugFile: "/tmp/x" }).success).toBe(true)
  })

  test("schema errors include the offending key name in path", () => {
    const r = OpentracePluginOptionsSchema.safeParse({ timeout: -5 })
    expect(r.success).toBe(false)
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."))
      expect(paths).toContain("timeout")
    }
  })
})

const savedEnv = { ...process.env }

function makeInput(directory = "/w"): any {
  return { directory }
}

describe("server() — assembly", () => {
  let fake: FakeCli

  beforeEach(() => {
    fake = new FakeCli()
    process.env.OPENTRACE_CMD = fake.bin
    fake.configure({ exitCode: 0, stdout: "" })
    configureDebug({ debug: false })
  })

  afterEach(() => {
    delete process.env.FAKE_STDOUT
    delete process.env.FAKE_STDERR
    delete process.env.FAKE_EXIT
    delete process.env.FAKE_SLEEP_MS
    delete process.env.FAKE_VERSION_EXIT
    delete process.env.FAKE_STDOUT_FILE
    if (savedEnv.OPENTRACE_CMD === undefined) delete process.env.OPENTRACE_CMD
    else process.env.OPENTRACE_CMD = savedEnv.OPENTRACE_CMD
    try {
      rmSync(fake.dir, { recursive: true, force: true })
    } catch {}
  })

  test("invalid options throws an Error with descriptive issue text", async () => {
    await expect(
      opentracePlugin.server(makeInput(), { tiemout: 5000 } as any),
    ).rejects.toThrow(/invalid options/)
  })

  test("error path names the offending key so the user can fix their config", async () => {
    let caught: Error | null = null
    try {
      await opentracePlugin.server(makeInput(), { timeout: -1 } as any)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain("timeout")
  })

  test("returns hooks with auth, tool, transform, and tool.execute.after", async () => {
    fake.configure({ exitCode: 0, stdout: '{"total_nodes":0,"total_edges":0,"nodes_by_type":{}}' })
    const hooks = await opentracePlugin.server(makeInput(), {})
    expect(hooks.auth).toBeDefined()
    expect(hooks.tool).toBeDefined()
    expect(Object.keys(hooks.tool!).sort()).toEqual([
      "opentrace_find_usages",
      "opentrace_graph_explore",
      "opentrace_graph_stats",
      "opentrace_impact_analysis",
      "opentrace_repo_index",
      "opentrace_semantic_search",
      "opentrace_source_grep",
      "opentrace_source_read",
      "opentrace_source_search",
    ])
    expect((hooks as any)["experimental.chat.system.transform"]).toBeTypeOf("function")
    expect((hooks as any)["tool.execute.after"]).toBeTypeOf("function")
  })
})

describe("server() — system-prompt transform", () => {
  let fake: FakeCli

  beforeEach(() => {
    fake = new FakeCli()
    process.env.OPENTRACE_CMD = fake.bin
    fake.configure({ exitCode: 0, stdout: "" })
    configureDebug({ debug: false })
  })

  afterEach(() => {
    delete process.env.FAKE_STDOUT
    delete process.env.FAKE_STDERR
    delete process.env.FAKE_EXIT
    delete process.env.FAKE_SLEEP_MS
    delete process.env.FAKE_VERSION_EXIT
    delete process.env.FAKE_STDOUT_FILE
    if (savedEnv.OPENTRACE_CMD === undefined) delete process.env.OPENTRACE_CMD
    else process.env.OPENTRACE_CMD = savedEnv.OPENTRACE_CMD
    try {
      rmSync(fake.dir, { recursive: true, force: true })
    } catch {}
  })

  test("pushes a single static-core entry when DB is missing (exit 3)", async () => {
    fake.configure({ exitCode: 3, stderr: "no db" })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const out = { system: [] as string[] }
    await transform({} as any, out)
    expect(out.system).toHaveLength(1)
    expect(out.system[0]).toContain("OpenTrace Knowledge Graph")
    expect(out.system[0]).not.toContain("Current state")
  })

  test("pushes core + dynamic appendix when stats and listRepos succeed (hasAppendix=true)", async () => {
    fake.configure({
      exitCode: 0,
      bySubcommand: {
        stats: '{"total_nodes":5,"total_edges":3,"nodes_by_type":{"Function":5}}',
        repos: "[]",
      },
    })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const out = { system: [] as string[] }
    await transform({} as any, out)
    expect(out.system).toHaveLength(1)
    expect(out.system[0]).toContain("Current state")
    expect(out.system[0]).toContain("5 nodes")
  })

  test("hasAppendix=true result is cached: a second transform within the TTL avoids re-running stats", async () => {
    fake.configure({
      exitCode: 0,
      bySubcommand: {
        stats: '{"total_nodes":5,"total_edges":3,"nodes_by_type":{"Function":5}}',
        repos: "[]",
      },
    })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const transform = (hooks as any)["experimental.chat.system.transform"]

    const out1 = { system: [] as string[] }
    await transform({} as any, out1)
    const out2 = { system: [] as string[] }
    await transform({} as any, out2)

    expect(out1.system[0]).toContain("Current state")
    expect(out2.system[0]).toContain("Current state")

    const argvs = fake.readSubcommandArgv()
    const statsCalls = argvs.filter((a) => a.includes("stats"))
    const reposCalls = argvs.filter((a) => a.includes("repos"))
    expect(statsCalls).toHaveLength(1)
    expect(reposCalls).toHaveLength(1)
  })

  test("static-only result is NOT cached: the next transform re-runs buildSystemPrompt", async () => {
    fake.configure({ exitCode: 3 })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const transform = (hooks as any)["experimental.chat.system.transform"]

    const out1 = { system: [] as string[] }
    await transform({} as any, out1)
    const out2 = { system: [] as string[] }
    await transform({} as any, out2)

    expect(out1.system[0]).toContain("OpenTrace Knowledge Graph")
    expect(out2.system[0]).toContain("OpenTrace Knowledge Graph")

    const argvs = fake.readSubcommandArgv()
    const statsCalls = argvs.filter((a) => a.includes("stats"))
    expect(statsCalls).toHaveLength(1)
  })

  test("when the dynamic appendix exceeds the 3s budget, the static core is still pushed", async () => {
    fake.configure({ exitCode: 0, sleepMs: 4_000, stdout: '{"total_nodes":1,"total_edges":1,"nodes_by_type":{}}' })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const out = { system: [] as string[] }
    const start = Date.now()
    await transform({} as any, out)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(3_700)
    expect(out.system).toHaveLength(1)
    expect(out.system[0]).toContain("OpenTrace Knowledge Graph")
  }, 10_000)

  test("internal exceptions are swallowed — transform never throws to the LLM pipeline", async () => {
    fake.configure({ exitCode: 0, stdout: "not-json" })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const transform = (hooks as any)["experimental.chat.system.transform"]
    const out = { system: [] as string[] }
    await expect(transform({} as any, out)).resolves.toBeUndefined()
    expect(out.system[0]).toContain("OpenTrace Knowledge Graph")
  })
})

describe("server() — tool.execute.after dispatch", () => {
  let fake: FakeCli

  beforeEach(() => {
    fake = new FakeCli()
    process.env.OPENTRACE_CMD = fake.bin
    fake.configure({ exitCode: 0, stdout: "" })
    configureDebug({ debug: false })
  })

  afterEach(() => {
    delete process.env.FAKE_STDOUT
    delete process.env.FAKE_STDERR
    delete process.env.FAKE_EXIT
    delete process.env.FAKE_SLEEP_MS
    delete process.env.FAKE_VERSION_EXIT
    delete process.env.FAKE_STDOUT_FILE
    if (savedEnv.OPENTRACE_CMD === undefined) delete process.env.OPENTRACE_CMD
    else process.env.OPENTRACE_CMD = savedEnv.OPENTRACE_CMD
    try {
      rmSync(fake.dir, { recursive: true, force: true })
    } catch {}
  })

  test("grep dispatches augment but not impact", async () => {
    fake.configure({ exitCode: 0, stdout: "AUG_GRAPH_CTX" })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const after = (hooks as any)["tool.execute.after"]
    const out = { title: "", output: "grep results", metadata: {} }
    await after(
      { tool: "grep", sessionID: "s", callID: "c", args: { pattern: "Foo" } },
      out,
    )
    expect(out.output).toContain("--- OpenTrace Graph Context ---")
    expect(out.output).toContain("AUG_GRAPH_CTX")
    expect(out.output).not.toContain("--- OpenTrace Impact Analysis ---")
    const argvs = fake.readSubcommandArgv()
    expect(argvs.some((a) => a.includes("augment"))).toBe(true)
    expect(argvs.some((a) => a.includes("impact"))).toBe(false)
  })

  test("edit dispatches impact but not augment", async () => {
    // Stdout has the `<--` arrow so impact actually appends.
    fake.configure({ exitCode: 0, stdout: "src/foo.ts <--CALLS-- src/bar.ts" })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const after = (hooks as any)["tool.execute.after"]
    const out = { title: "", output: "edit done", metadata: {} }
    await after(
      { tool: "edit", sessionID: "s", callID: "c", args: { filePath: "src/foo.ts" } },
      out,
    )
    expect(out.output).toContain("--- OpenTrace Impact Analysis ---")
    expect(out.output).toContain("<--CALLS--")
    expect(out.output).not.toContain("--- OpenTrace Graph Context ---")
    const argvs = fake.readSubcommandArgv()
    expect(argvs.some((a) => a.includes("impact"))).toBe(true)
    expect(argvs.some((a) => a.includes("augment"))).toBe(false)
  })

  test("read is a no-op — neither augment nor impact filter matches", async () => {
    fake.configure({ exitCode: 0, stdout: "should not be appended" })
    const hooks = await opentracePlugin.server(makeInput(), {})
    const after = (hooks as any)["tool.execute.after"]
    const out = { title: "", output: "original", metadata: {} }

    await after(
      { tool: "read", sessionID: "s", callID: "c", args: { filePath: "src/foo.ts" } },
      out,
    )
    expect(out.output).toBe("original")
    expect(fake.readSubcommandArgv().length).toBe(0)
  })
})
