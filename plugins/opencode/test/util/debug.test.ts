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
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configureDebug, debug, isDebug } from "../../src/util/debug.js"

describe("debug logging", () => {
  let tmp: string
  let logFile: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "opentrace-debug-"))
    logFile = join(tmp, "debug.log")
  })

  afterEach(() => {
    configureDebug({ debug: false })
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
  })

  test("debug() is a no-op when disabled", () => {
    configureDebug({ debug: false, debugFile: logFile })
    debug("scope", "should not appear")
    expect(existsSync(logFile)).toBe(false)
    expect(isDebug()).toBe(false)
  })

  test("configureDebug({ debug: true }) writes a header line", () => {
    configureDebug({ debug: true, debugFile: logFile })
    expect(isDebug()).toBe(true)
    const content = readFileSync(logFile, "utf8")
    expect(content).toContain("[opentrace:plugin]")
    expect(content).toContain("debug enabled")
  })

  test("debug() formats scope and message", () => {
    configureDebug({ debug: true, debugFile: logFile })
    debug("graph", "hello", { count: 3 })
    const content = readFileSync(logFile, "utf8")
    expect(content).toContain("[opentrace:graph] hello")
    expect(content).toContain('{"count":3}')
  })

  test("Error values stringify with their stack/message", () => {
    configureDebug({ debug: true, debugFile: logFile })
    debug("graph", new Error("boom"))
    const content = readFileSync(logFile, "utf8")
    expect(content).toContain("Error: boom")
  })

  test("non-serializable circular values fall back to String() without throwing", () => {
    configureDebug({ debug: true, debugFile: logFile })
    const circ: any = {}
    circ.self = circ
    expect(() => debug("graph", circ)).not.toThrow()
    const content = readFileSync(logFile, "utf8")
    expect(content).toContain("[opentrace:graph]")
  })

  test("rotation: a >5MB log is renamed to .1 on configureDebug; live file restarts at the header", () => {
    const blob = "x".repeat(6 * 1024 * 1024)
    writeFileSync(logFile, blob)

    configureDebug({ debug: true, debugFile: logFile })

    const backup = logFile + ".1"
    expect(existsSync(backup)).toBe(true)
    expect(statSync(backup).size).toBe(blob.length)

    const live = readFileSync(logFile, "utf8")
    expect(live).toContain("debug enabled")
    expect(live.length).toBeLessThan(1024)
  })

  test("rotation: an existing .1 backup is replaced (not piled into .2)", () => {
    writeFileSync(logFile, "round-one-content" + "x".repeat(6 * 1024 * 1024))
    configureDebug({ debug: true, debugFile: logFile })
    const backup = logFile + ".1"
    expect(existsSync(backup)).toBe(true)

    const marker = "ROUND_TWO_MARKER"
    writeFileSync(logFile, marker + "y".repeat(6 * 1024 * 1024))
    configureDebug({ debug: true, debugFile: logFile })

    const newBackup = readFileSync(backup, "utf8")
    expect(newBackup.startsWith(marker)).toBe(true)
    expect(existsSync(logFile + ".2")).toBe(false)
  })

  test("rotation: a sub-cap log is left alone", () => {
    const small = "a".repeat(1024)
    writeFileSync(logFile, small)

    configureDebug({ debug: true, debugFile: logFile })

    expect(existsSync(logFile + ".1")).toBe(false)
    const content = readFileSync(logFile, "utf8")
    expect(content.startsWith(small)).toBe(true)
    expect(content).toContain("debug enabled")
  })
})
