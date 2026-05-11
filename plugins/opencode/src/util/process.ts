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

/**
 * Cross-runtime process + PATH helpers.
 *
 * Both APIs route through `node:child_process` and `node:fs`, which Bun
 * fully reimplements. That means the same bundle works under Bun (CLI /
 * TUI) and Node (the OpenCode desktop's Electron utility process). The
 * earlier `Bun.spawn` / `Bun.which` path threw a synchronous
 * ReferenceError in the desktop sidecar, causing the plugin's `server()`
 * factory to reject after `configureDebug()` and silently abandon every
 * hook registration. See git blame for the diagnosis trail.
 */

import { spawn } from "node:child_process"
import { statSync } from "node:fs"
import { delimiter, join } from "node:path"

export interface RunResult {
  /** Process exit code. -1 when killed before exit (e.g. timeout, signal). */
  exitCode: number
  stdout: string
  stderr: string
  /** True when the kill timer fired before the process exited on its own. */
  timedOut: boolean
}

/**
 * Spawn a process, accumulate stdout/stderr, and resolve on exit. Mirrors
 * the shape we previously got from `Bun.spawn` + `proc.exited` + a manual
 * `new Response(proc.stdout).text()`, in a single call.
 *
 * Stdout/stderr are drained via `data` events so the pipes never deadlock
 * on a chatty subprocess — the prior Bun-based code intentionally read
 * the streams before awaiting exit for the same reason.
 */
export async function runCommand(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child
    try {
      child = spawn(cmd, args, {
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (e) {
      // Synchronous spawn errors are rare (Node usually reports via the
      // async "error" event), but reject so callers can match on
      // `isMissingBinaryError` consistently with the async path.
      reject(e)
      return
    }

    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, opts.timeoutMs)
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c))
    child.stderr?.on("data", (c: Buffer) => stderrChunks.push(c))

    // Resolve on `exit` rather than `close`. `close` waits for every stdio
    // pipe to release, which lags arbitrarily when the spawned process
    // forks a grandchild that inherits the pipes (e.g. a shell `sleep`
    // outlives its parent shell). Bun's `proc.exited` resolved on process
    // exit only — matching that here keeps the kill-and-move-on contract
    // the rest of the codebase assumes.
    child.once("error", (e) => {
      if (killTimer) clearTimeout(killTimer)
      reject(e)
    })
    child.once("exit", (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      // Detach our reader from any pipe still held by a grandchild so the
      // event loop can drain. The chunks already collected stay in our
      // local arrays.
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        // Killed-by-signal exits report a null code; surface -1 so callers
        // can distinguish from a normal "exit 0".
        exitCode: code ?? (signal ? -1 : -1),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      })
    })
  })
}

/**
 * PATH-scan replacement for `Bun.which`. Returns the absolute path of the
 * first executable named *name* found on *PATH*, or null. On Windows,
 * tries the standard PATHEXT suffixes so `opentraceai.exe`/`.cmd`/`.bat`
 * shims resolve.
 *
 * Symlinks are dereferenced by `statSync`, matching `Bun.which`'s
 * behavior for typical `uv tool install` / `pipx install` shim layouts.
 */
export function whichSync(name: string, opts: { PATH: string }): string | null {
  const exts =
    process.platform === "win32"
      ? splitPathExt(process.env.PATHEXT) ?? [".exe", ".cmd", ".bat", ".com", ""]
      : [""]
  for (const dir of opts.PATH.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      try {
        const st = statSync(candidate)
        if (st.isFile()) return candidate
      } catch {
        // ENOENT / ENOTDIR / EACCES — keep scanning.
      }
    }
  }
  return null
}

function splitPathExt(pathext: string | undefined): string[] | null {
  if (!pathext) return null
  const parts = pathext
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase())
  // Always try the bare name too so a no-extension script still resolves.
  return [...parts, ""]
}
