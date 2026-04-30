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
import { createToolImpactHook } from "../../src/hooks/tool-impact.js"
import { makeGraphClientStub } from "../_helpers/graph-client-stub.js"

function makeOutput(initial = "edit confirmed") {
  return { title: "", output: initial, metadata: {} }
}
function makeInput(tool: string, args: any = { filePath: "src/foo.ts" }) {
  return { tool, sessionID: "s", callID: "c", args }
}

describe("createToolImpactHook", () => {
  test("only fires for edit and write — other tools are no-ops", async () => {
    let calls = 0
    const client = makeGraphClientStub({
      impact: async () => {
        calls++
        return "ignored"
      },
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    await hook(makeInput("read"), out)
    await hook(makeInput("grep"), out)
    await hook(makeInput("glob"), out)
    expect(calls).toBe(0)
    expect(out.output).toBe("edit confirmed")
  })

  test("appends impact analysis when the result has a dependent arrow", async () => {
    const client = makeGraphClientStub({
      impact: async () => "src/foo.ts <--CALLS-- src/bar.ts",
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    await hook(makeInput("edit", { filePath: "src/foo.ts" }), out)
    expect(out.output).toContain("--- OpenTrace Impact Analysis ---")
    expect(out.output).toContain("<--CALLS--")
  })

  test("works for write as well as edit", async () => {
    const client = makeGraphClientStub({
      impact: async () => "<--IMPORTS-- something",
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    await hook(makeInput("write", { filePath: "src/foo.ts" }), out)
    expect(out.output).toContain("--- OpenTrace Impact Analysis ---")
  })

  test("suppresses the header when impact reports no dependents", async () => {
    const client = makeGraphClientStub({
      impact: async () => "src/foo.ts: no dependents found",
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    await hook(makeInput("edit", { filePath: "src/foo.ts" }), out)
    expect(out.output).toBe("edit confirmed")
  })

  test("skips when the graph isn't ready", async () => {
    let called = false
    const client = makeGraphClientStub({
      dbReadyHint: () => false,
      impact: async () => {
        called = true
        return "<-- something"
      },
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    await hook(makeInput("edit"), out)
    expect(called).toBe(false)
    expect(out.output).toBe("edit confirmed")
  })

  test("skips when filePath is missing", async () => {
    const client = makeGraphClientStub({
      impact: async () => "<-- ignore",
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    await hook(makeInput("edit", {}), out)
    expect(out.output).toBe("edit confirmed")
  })

  test("a slow impact call (>3s) is timed out", async () => {
    const client = makeGraphClientStub({
      impact: () => new Promise((r) => setTimeout(() => r("<-- late"), 4000)),
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    const start = Date.now()
    await hook(makeInput("edit"), out)
    const elapsed = Date.now() - start
    expect(out.output).toBe("edit confirmed")
    expect(elapsed).toBeLessThan(3_900)
  }, 10_000)

  test("swallows exceptions from impact", async () => {
    const client = makeGraphClientStub({
      impact: async () => {
        throw new Error("boom")
      },
    })
    const hook = createToolImpactHook(client)
    const out = makeOutput()
    await expect(hook(makeInput("edit"), out)).resolves.toBeUndefined()
    expect(out.output).toBe("edit confirmed")
  })
})
