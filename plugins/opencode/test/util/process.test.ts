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
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { runCommand, whichSync } from "../../src/util/process.js"

describe("runCommand", () => {
  test("captures stdout and stderr separately on a zero-exit subprocess", async () => {
    const result = await runCommand("/bin/sh", ["-c", "printf out; printf err >&2; exit 0"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("out")
    expect(result.stderr).toBe("err")
    expect(result.timedOut).toBe(false)
  })

  test("propagates non-zero exit codes verbatim", async () => {
    const result = await runCommand("/bin/sh", ["-c", "exit 7"])
    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
  })

  test("rejects when the binary cannot be spawned (ENOENT)", async () => {
    await expect(
      runCommand("/definitely/not/a/real/binary/path", []),
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("kills and reports timedOut=true when the deadline elapses", async () => {
    const start = Date.now()
    const result = await runCommand("/bin/sh", ["-c", "sleep 5"], { timeoutMs: 150 })
    const elapsed = Date.now() - start
    // 150ms timeout; allow generous slack for CI but stay well under sleep 5
    expect(elapsed).toBeLessThan(2_000)
    expect(result.timedOut).toBe(true)
    // Killed by signal — exit code is -1 in our normalized shape.
    expect(result.exitCode).toBe(-1)
  })

  test("treats timeoutMs <= 0 as no-timeout (long-running subprocess completes)", async () => {
    const result = await runCommand("/bin/sh", ["-c", "sleep 0.2; echo done"], { timeoutMs: 0 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe("done")
    expect(result.timedOut).toBe(false)
  })

  test("forwards a custom env to the child without polluting process.env", async () => {
    const before = process.env.OPENTRACE_TEST_VAR
    const result = await runCommand("/bin/sh", ["-c", "printf %s \"$OPENTRACE_TEST_VAR\""], {
      env: { ...process.env, OPENTRACE_TEST_VAR: "hello" },
    })
    expect(result.stdout).toBe("hello")
    // Local env in our process must be untouched — Node passes env by value.
    expect(process.env.OPENTRACE_TEST_VAR).toBe(before)
  })

  test("drains long stdout without pipe deadlock", async () => {
    // 64 KB output — past the typical pipe buffer cap. With a naive
    // "await exit before reading stdout" the child would block on a full
    // pipe; runCommand drains via data events so this just works.
    const result = await runCommand("/bin/sh", ["-c", "head -c 65536 /dev/zero | tr '\\0' 'x'"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBe(65536)
  })
})

describe("whichSync", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "opentrace-which-"))
  })
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
  })

  test("returns the absolute path of the first match on PATH", () => {
    const bin = join(tmp, "mytool")
    writeFileSync(bin, "#!/bin/sh\necho hi\n")
    chmodSync(bin, 0o755)
    const found = whichSync("mytool", { PATH: tmp })
    expect(found).toBe(bin)
  })

  test("returns null when no match exists on PATH", () => {
    expect(whichSync("does-not-exist-anywhere", { PATH: tmp })).toBeNull()
  })

  test("walks every PATH segment until a match is found", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "opentrace-which2-"))
    try {
      const bin = join(tmp2, "needle")
      writeFileSync(bin, "#!/bin/sh\n")
      chmodSync(bin, 0o755)
      const found = whichSync("needle", { PATH: `${tmp}${delimiter}${tmp2}` })
      expect(found).toBe(bin)
    } finally {
      rmSync(tmp2, { recursive: true, force: true })
    }
  })

  test("skips empty PATH segments and unreadable directories", () => {
    const bin = join(tmp, "tool")
    writeFileSync(bin, "#!/bin/sh\n")
    chmodSync(bin, 0o755)
    // Leading and trailing empty segments + a nonexistent dir between.
    const path = `${delimiter}${delimiter}/no/such/dir${delimiter}${tmp}${delimiter}`
    expect(whichSync("tool", { PATH: path })).toBe(bin)
  })

  test("does not match directories that happen to share the name", () => {
    // A directory called "mytool" must not be returned as the executable.
    require("node:fs").mkdirSync(join(tmp, "mytool"))
    expect(whichSync("mytool", { PATH: tmp })).toBeNull()
  })
})
