/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Scriptable fake `opentraceai` binary. Each invocation's argv is appended
 * to {@link argvLog} as one JSON line. Behavior is configured via FAKE_*
 * env vars consumed by the spawned shell script:
 *   FAKE_STDOUT, FAKE_STDOUT_FILE, FAKE_STDERR, FAKE_EXIT, FAKE_SLEEP_MS,
 *   FAKE_VERSION_EXIT, FAKE_STDOUT_BY_<SUBCMD>.
 */
export class FakeCli {
  readonly dir: string
  readonly bin: string
  readonly argvLog: string

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "opentrace-fakecli-"))
    this.bin = join(this.dir, "opentraceai")
    this.argvLog = join(this.dir, "argv.log")
    writeFileSync(this.argvLog, "")
    writeFileSync(this.bin, FAKE_SCRIPT.replace("__ARGV_LOG__", this.argvLog))
    chmodSync(this.bin, 0o755)
  }

  configure(opts: FakeOpts): void {
    process.env.FAKE_STDOUT = opts.stdout ?? ""
    process.env.FAKE_STDERR = opts.stderr ?? ""
    process.env.FAKE_EXIT = String(opts.exitCode ?? 0)
    process.env.FAKE_SLEEP_MS = String(opts.sleepMs ?? 0)
    process.env.FAKE_VERSION_EXIT = String(opts.versionExitCode ?? 0)
    if (opts.stdoutFile) {
      process.env.FAKE_STDOUT_FILE = opts.stdoutFile
    } else {
      delete process.env.FAKE_STDOUT_FILE
    }
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("FAKE_STDOUT_BY_")) delete process.env[k]
    }
    if (opts.bySubcommand) {
      for (const [sub, val] of Object.entries(opts.bySubcommand)) {
        process.env[`FAKE_STDOUT_BY_${sub.replace(/-/g, "_").toUpperCase()}`] = val
      }
    }
  }

  /** Read every recorded argv as a list of arrays. */
  readArgvLog(): string[][] {
    if (!existsSync(this.argvLog)) return []
    const content = readFileSync(this.argvLog, "utf8")
    return content
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
  }

  /** Argv lists for non-version invocations only. */
  readSubcommandArgv(): string[][] {
    return this.readArgvLog().filter((argv) => argv[0] !== "--version")
  }
}

interface FakeOpts {
  stdout?: string
  stdoutFile?: string
  stderr?: string
  exitCode?: number
  sleepMs?: number
  versionExitCode?: number
  /** Per-subcommand stdout overrides keyed by the subcommand name in argv. */
  bySubcommand?: Record<string, string>
}

const FAKE_SCRIPT = `#!/bin/sh
ARGV_LOG="__ARGV_LOG__"
{
  printf '['
  first=1
  for arg in "$@"; do
    if [ $first -eq 1 ]; then first=0; else printf ','; fi
    esc=\$(printf %s "$arg" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
    printf '"%s"' "$esc"
  done
  printf ']\\n'
} >> "$ARGV_LOG"

if [ "$1" = "--version" ]; then
  exit \${FAKE_VERSION_EXIT:-0}
fi

if [ "$1" = "--workspace" ]; then
  SUBCMD="$3"
else
  SUBCMD="$1"
fi
NORM=\$(printf '%s' "$SUBCMD" | tr 'a-z-' 'A-Z_')
PER_SUBCMD_VAR="FAKE_STDOUT_BY_$NORM"
# \${VAR+x} distinguishes unset (use default) from set-to-empty (honor empty).
eval "OVERRIDE_SET=\\\${$PER_SUBCMD_VAR+x}"
if [ -n "\$OVERRIDE_SET" ]; then
  eval "OVERRIDE=\\\$$PER_SUBCMD_VAR"
  printf '%s' "\$OVERRIDE"
elif [ -n "\${FAKE_STDOUT_FILE:-}" ]; then
  cat "$FAKE_STDOUT_FILE"
elif [ -n "\${FAKE_STDOUT:-}" ]; then
  printf '%s' "$FAKE_STDOUT"
fi

if [ -n "\${FAKE_STDERR:-}" ]; then
  printf '%s' "$FAKE_STDERR" >&2
fi

# exec into python so SIGTERM is delivered reliably (sh doesn't forward it).
if [ -n "\${FAKE_SLEEP_MS:-}" ] && [ "\${FAKE_SLEEP_MS:-0}" -gt 0 ]; then
  exec python3 -c "import time, sys; time.sleep(\${FAKE_SLEEP_MS} / 1000.0); sys.exit(\${FAKE_EXIT:-0})"
fi

exit \${FAKE_EXIT:-0}
`
