/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { findExecutable, pathWithLocalBin } from "../../src/util/db-discovery.js"

describe("pathWithLocalBin", () => {
  const origPath = process.env.PATH
  afterEach(() => {
    process.env.PATH = origPath
  })

  test("prepends ~/.local/bin to PATH using the platform delimiter", () => {
    process.env.PATH = `/usr/bin${delimiter}/bin`
    const out = pathWithLocalBin()
    const segments = out.split(delimiter)
    expect(segments[0]).toMatch(/\.local[\\/]bin$/)
    expect(out).toContain("/usr/bin")
    expect(out).toContain("/bin")
  })

  test("tolerates an undefined PATH", () => {
    delete process.env.PATH
    const out = pathWithLocalBin()
    const segments = out.split(delimiter)
    expect(segments[0]).toMatch(/\.local[\\/]bin$/)
  })
})

// PATH-discovery uses Bun.which against pathWithLocalBin() which reads
// node:os homedir() — bun caches that at startup, so tests here only
// exercise the OPENTRACE_CMD branch (fully controllable via env + tmpdir).
describe("findExecutable (OPENTRACE_CMD branch)", () => {
  let tmp: string
  const savedEnv = { ...process.env }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "opentrace-discovery-"))
    delete process.env.OPENTRACE_CMD
  })

  afterEach(() => {
    process.env = { ...savedEnv }
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
  })

  function writeStub(name: string, body: string): string {
    const p = join(tmp, name)
    writeFileSync(p, body)
    chmodSync(p, 0o755)
    return p
  }

  test("OPENTRACE_CMD pointing at a probe-OK binary is used verbatim", async () => {
    const stub = writeStub("custom-bin", "#!/bin/sh\necho stub-version 0.1\n")
    process.env.OPENTRACE_CMD = stub
    const found = await findExecutable()
    expect(found).not.toBeNull()
    expect(found!.cmd).toBe(stub)
    expect(found!.args).toEqual([])
  })

  test("OPENTRACE_CMD with arguments tokenizes correctly", async () => {
    const stub = writeStub(
      "wrapper",
      `#!/bin/sh\nif [ "$1" = "opentraceai" ]; then echo "wrapped 1.0"; exit 0; fi\nexit 2\n`,
    )
    process.env.OPENTRACE_CMD = `${stub} opentraceai`
    const found = await findExecutable()
    expect(found).not.toBeNull()
    expect(found!.cmd).toBe(stub)
    expect(found!.args).toEqual(["opentraceai"])
  })

  test("OPENTRACE_CMD honors single-quoted spans for paths with spaces", async () => {
    const dirWithSpace = join(tmp, "with space")
    require("node:fs").mkdirSync(dirWithSpace)
    const stubPath = join(dirWithSpace, "opentraceai")
    writeFileSync(stubPath, "#!/bin/sh\necho ok\n")
    chmodSync(stubPath, 0o755)
    process.env.OPENTRACE_CMD = `'${stubPath}'`
    const found = await findExecutable()
    expect(found).not.toBeNull()
    expect(found!.cmd).toBe(stubPath)
  })

  test("OPENTRACE_CMD whose --version probe fails returns null", async () => {
    const stub = writeStub("broken", "#!/bin/sh\nexit 7\n")
    process.env.OPENTRACE_CMD = stub
    expect(await findExecutable()).toBeNull()
  })

  test("OPENTRACE_CMD pointing at a non-existent binary returns null", async () => {
    process.env.OPENTRACE_CMD = join(tmp, "does-not-exist")
    expect(await findExecutable()).toBeNull()
  })

  test("OPENTRACE_CMD whose --version exceeds the 2s probe budget is killed and rejected", async () => {
    const stub = writeStub("hang", "#!/bin/sh\nsleep 10\n")
    process.env.OPENTRACE_CMD = stub
    const start = Date.now()
    const result = await findExecutable()
    const elapsed = Date.now() - start
    expect(result).toBeNull()
    expect(elapsed).toBeLessThan(5_000)
  }, 10_000)
})
