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

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DEFAULT_LOG_FILE = join(homedir(), ".opentrace", "debug.log")

// Rotate when the active log reaches this size. One .1 backup is kept.
// Bounds disk usage to roughly 2x this value across sessions.
const MAX_LOG_BYTES = 5 * 1024 * 1024 // 5 MB
// Amortize the size check — statSync-ing on every write is wasteful, and
// over-shooting the cap by a few hundred KB is fine for a debug log.
const ROTATE_CHECK_INTERVAL = 200

// Debug is off until configureDebug() is called with { debug: true }.
let enabled = false
let logFile = DEFAULT_LOG_FILE
let logDirReady = false
let writesSinceCheck = 0

function ensureLogDir(): void {
  if (logDirReady) return
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    logDirReady = true
  } catch {
    // If we can't create the dir, appendFileSync below will also fail and silently drop.
  }
}

function rotateIfNeeded(): void {
  try {
    const st = statSync(logFile)
    if (st.size <= MAX_LOG_BYTES) return
    const backup = logFile + ".1"
    try {
      unlinkSync(backup)
    } catch {
      // Previous backup may not exist — that's fine.
    }
    renameSync(logFile, backup)
  } catch {
    // File doesn't exist yet (first write), or permissions issue — skip.
  }
}

function format(part: unknown): string {
  if (part instanceof Error) {
    return part.stack ?? `${part.name}: ${part.message}`
  }
  if (typeof part === "string") return part
  try {
    return JSON.stringify(part)
  } catch {
    return String(part)
  }
}

function write(line: string): void {
  if (++writesSinceCheck >= ROTATE_CHECK_INTERVAL) {
    writesSinceCheck = 0
    rotateIfNeeded()
  }
  // TUIs like OpenCode capture or overdraw stderr, so debug output is invisible
  // in the user's terminal. Write to a file the user can tail from a second terminal.
  // Also emit to stderr in case someone is running a non-TUI client.
  try {
    process.stderr.write(line)
  } catch {}
  try {
    ensureLogDir()
    appendFileSync(logFile, line)
  } catch {}
}

export function debug(scope: string, ...parts: unknown[]): void {
  if (!enabled) return
  const msg = parts.map(format).join(" ")
  write(`${new Date().toISOString()} [opentrace:${scope}] ${msg}\n`)
}

export function isDebug(): boolean {
  return enabled
}

/**
 * Apply plugin options. Called once at plugin init.
 * Enables debug logging if `debug === true` and redirects the log file
 * if `debugFile` is set. Debug is off by default.
 */
export function configureDebug(opts: { debug?: boolean; debugFile?: string }): void {
  enabled = opts.debug === true
  if (opts.debugFile) {
    logFile = opts.debugFile
    logDirReady = false
  }
  if (!enabled) return
  // Handle rotation at config time so a long-lived log doesn't survive forever
  // if a user only hits low-frequency code paths during a session.
  rotateIfNeeded()
  write(
    `${new Date().toISOString()} [opentrace:plugin] debug enabled logFile=${JSON.stringify(logFile)} pid=${process.pid}\n`,
  )
}
