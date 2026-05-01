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

import { homedir } from "node:os"
import { join, delimiter } from "node:path"
import { debug } from "./debug.js"

// Hard cap on how long `<cmd> --version` is allowed to run. The probe is
// awaited synchronously by `GraphClient.run` / `runWithTimeout` before the
// per-call timer is armed, so an unkilled hang here would wedge every tool
// call indefinitely. 2s is generous for any sane CLI's --version path.
const PROBE_TIMEOUT_MS = 2_000

/**
 * PATH used when probing or invoking the CLI. Prepends the standard
 * `uv tool install` / `pipx install` shim directory so the binary is
 * found even when the parent shell's PATH doesn't include it (a common
 * case under launched GUIs and IDE plugins). `homedir()` + `delimiter`
 * keeps it portable across macOS, Linux, and Windows.
 *
 * Single source of truth: probe-time (`findExecutable`) and run-time
 * (`spawnEnvWithLocalBin` in graph-client.ts) MUST resolve candidates
 * under the same PATH, otherwise a candidate that probes ok could
 * resolve to a different binary at run time, or vice versa.
 */
export function pathWithLocalBin(): string {
  return `${join(homedir(), ".local", "bin")}${delimiter}${process.env.PATH ?? ""}`
}

/**
 * Split an OPENTRACE_CMD value into argv tokens with minimal shell-style
 * quoting: bare runs of non-whitespace, plus single- and double-quoted
 * spans (so users can embed paths containing spaces). No escapes, no
 * variable expansion — anything fancier should live in a wrapper script
 * that OPENTRACE_CMD points at.
 */
function tokenizeCmd(s: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3])
  }
  return tokens
}

/**
 * Side-effect-free check that a candidate command can actually run. Spawning
 * `<cmd> <args...> --version` is the cheapest way to validate a binary
 * without invoking any indexing or downloading work.
 *
 * `searchPath` is the PATH used for resolving the candidate's first token —
 * the caller threads in the same `~/.local/bin`-prepended value the actual
 * CLI invocations use, so a candidate like `uvx opentraceai` (with `uvx`
 * installed by `uv` into `~/.local/bin`) probes successfully even when the
 * inherited shell PATH wouldn't find it.
 *
 * Bounded by {@link PROBE_TIMEOUT_MS}; a hung process is killed and treated
 * as a failed probe.
 */
async function probeVersion(
  cand: { cmd: string; args: string[] },
  searchPath: string,
): Promise<boolean> {
  try {
    const proc = Bun.spawn([cand.cmd, ...cand.args, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: searchPath },
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, PROBE_TIMEOUT_MS)
    const exitCode = await proc.exited
    clearTimeout(timer)
    if (timedOut) {
      debug("db", "probeVersion: timed out", cand.cmd, cand.args.join(" "))
      return false
    }
    return exitCode === 0
  } catch {
    return false
  }
}

/**
 * Find a working `opentraceai` invocation. Returns null if none probes ok.
 *
 * Order:
 *   1. `OPENTRACE_CMD` env var — explicit user override; probed.
 *   2. `opentraceai` on PATH (with `~/.local/bin` prepended) — probed.
 *
 * `uv run opentraceai` and `uvx opentraceai` are intentionally NOT
 * auto-fallbacks: probing them can sync uv-managed deps or download from
 * PyPI as a side effect, i.e. silently install software the user didn't
 * consent to. Users wanting either form should set OPENTRACE_CMD
 * explicitly (e.g. `OPENTRACE_CMD="uvx opentraceai"`), which routes
 * through path 1 and gets probed.
 */
export async function findExecutable(): Promise<{ cmd: string; args: string[] } | null> {
  const searchPath = pathWithLocalBin()

  // 1. Explicit override.
  const envCmd = process.env.OPENTRACE_CMD
  if (envCmd) {
    const parts = tokenizeCmd(envCmd)
    if (parts.length === 0) {
      debug("db", "findExecutable: OPENTRACE_CMD is empty after tokenize, ignoring")
    } else {
      const cand = { cmd: parts[0], args: parts.slice(1) }
      if (await probeVersion(cand, searchPath)) {
        debug("db", "findExecutable: using OPENTRACE_CMD override", envCmd)
        return cand
      }
      // An explicit override that doesn't work shouldn't silently fall through —
      // the user set it for a reason and would want to know it's broken.
      debug("db", "findExecutable: OPENTRACE_CMD set but probe failed", envCmd)
      return null
    }
  }

  // 2. Direct binary on PATH (including ~/.local/bin where `uv tool install`
  //    and `pipx install` drop their shims). `Bun.which` does the lookup in
  //    the runtime — no shelling out to `which` (which doesn't exist on
  //    Windows by default), and on Windows it honors PATHEXT so an
  //    `opentraceai.exe` shim resolves the same way.
  const found = Bun.which("opentraceai", { PATH: searchPath })
  if (found) {
    const cand = { cmd: found, args: [] }
    // Bun.which confirms the path resolves; --version confirms it's actually
    // a working opentraceai (and not a stale shim or unrelated binary).
    if (await probeVersion(cand, searchPath)) {
      debug("db", "findExecutable: found on PATH at", found)
      return cand
    }
    debug("db", "findExecutable: Bun.which returned a path but --version failed", found)
  }

  debug("db", "findExecutable: no opentraceai binary found")
  return null
}
