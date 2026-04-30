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
import { createToolAugmentHook } from "../../src/hooks/tool-augment.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

function makeOutput(initial = "original output") {
  return { title: "", output: initial, metadata: {} }
}

function makeInput(tool: string, args: any = { pattern: "Foo" }) {
  return { tool, sessionID: "s1", callID: "c1", args }
}

describe("createToolAugmentHook", () => {
  test("only fires for grep and glob — other tools are no-ops", async () => {
    let calls = 0
    const client = makeGraphClientStub({
      augment: async () => {
        calls++
        return "appended"
      },
    })
    const hook = createToolAugmentHook(client)

    const out = makeOutput()
    await hook(makeInput("read"), out)
    await hook(makeInput("write"), out)
    await hook(makeInput("edit"), out)
    expect(calls).toBe(0)
    expect(out.output).toBe("original output")
  })

  test("appends graph context after a grep with a pattern arg", async () => {
    const client = makeGraphClientStub({
      augment: async (pattern) => `MATCH ${pattern}: Function foo`,
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput("grep results...")
    await hook(makeInput("grep", { pattern: "myFunc" }), out)
    expect(out.output).toContain("grep results...")
    expect(out.output).toContain("--- OpenTrace Graph Context ---")
    expect(out.output).toContain("MATCH myFunc: Function foo")
  })

  test("appends graph context after a glob with a pattern arg", async () => {
    const client = makeGraphClientStub({
      augment: async (pattern) => `MATCH ${pattern}`,
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    await hook(makeInput("glob", { pattern: "**/*.ts" }), out)
    expect(out.output).toContain("--- OpenTrace Graph Context ---")
    expect(out.output).toContain("MATCH **/*.ts")
  })

  test("skips when the graph isn't ready (dbReadyHint === false)", async () => {
    let augmentCalled = false
    const client = makeGraphClientStub({
      dbReadyHint: () => false,
      augment: async () => {
        augmentCalled = true
        return "should not be reached"
      },
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    await hook(makeInput("grep"), out)
    expect(augmentCalled).toBe(false)
    expect(out.output).toBe("original output")
  })

  test("dbReadyHint === null still permits the call (cold cache)", async () => {
    let called = false
    const client = makeGraphClientStub({
      dbReadyHint: () => null,
      augment: async () => {
        called = true
        return "context"
      },
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    await hook(makeInput("grep"), out)
    expect(called).toBe(true)
    expect(out.output).toContain("context")
  })

  test("skips when args has no pattern", async () => {
    const client = makeGraphClientStub({
      augment: async () => "should not append",
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    await hook(makeInput("grep", {}), out)
    expect(out.output).toBe("original output")
  })

  test("skips when pattern is not a string", async () => {
    const client = makeGraphClientStub({
      augment: async () => "should not append",
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    await hook(makeInput("grep", { pattern: 42 }), out)
    expect(out.output).toBe("original output")
  })

  test("does not append when augment returns null", async () => {
    const client = makeGraphClientStub({
      augment: async () => null,
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    await hook(makeInput("grep"), out)
    expect(out.output).toBe("original output")
  })

  test("a slow augment call (>3s) is timed out and does not append", async () => {
    const client = makeGraphClientStub({
      augment: () => new Promise((r) => setTimeout(() => r("late"), 4000)),
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    const start = Date.now()
    await hook(makeInput("grep"), out)
    const elapsed = Date.now() - start
    expect(out.output).toBe("original output")
    expect(elapsed).toBeLessThan(3_900)
  }, 10_000)

  test("swallows exceptions from augment", async () => {
    const client = makeGraphClientStub({
      augment: async () => {
        throw new Error("boom")
      },
    })
    const hook = createToolAugmentHook(client)
    const out = makeOutput()
    await expect(hook(makeInput("grep"), out)).resolves.toBeUndefined()
    expect(out.output).toBe("original output")
  })
})
