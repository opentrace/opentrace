#!/usr/bin/env bash
# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# SessionStart hook: inject OpenTrace graph awareness into the session.
# Walks up from cwd looking for .opentrace/index.db, then runs
# `opentraceai stats` to show what's indexed.

set -euo pipefail

# ---------------------------------------------------------------------------
# Debug logging — enabled via OPENTRACE_DEBUG (see scripts/_debug.py for the
# Python-side equivalent). Writes timestamped lines to stderr and, when a
# .opentrace/ directory can be located, appends to .opentrace/hook-debug.log.
# NEVER write debug output to stdout — stdout is parsed as JSON by Claude.
# ---------------------------------------------------------------------------
OT_DEBUG="${OPENTRACE_DEBUG:-}"
OT_LOG_PATH=""

if [ -n "$OT_DEBUG" ]; then
  if [ -n "${OPENTRACE_DEBUG_LOG:-}" ]; then
    OT_LOG_PATH="$OPENTRACE_DEBUG_LOG"
  else
    # Walk up from cwd for an existing .opentrace/ dir (cap at 10 levels).
    _CUR="$(pwd)"
    for _ in $(seq 1 10); do
      if [ -d "$_CUR/.opentrace" ]; then
        OT_LOG_PATH="$(cd "$_CUR/.opentrace" && pwd)/hook-debug.log"
        break
      fi
      _PARENT="$(dirname "$_CUR")"
      [ "$_PARENT" = "$_CUR" ] && break
      [ -e "$_CUR/.git" ] && break
      _CUR="$_PARENT"
    done
    unset _CUR _PARENT
  fi
fi

_ot_log() {
  [ -z "$OT_DEBUG" ] && return 0
  local line
  line="$(date -u +'%Y-%m-%dT%H:%M:%S') [session-start] $*"
  printf '%s\n' "$line" >&2
  if [ -n "$OT_LOG_PATH" ]; then
    printf '%s\n' "$line" >> "$OT_LOG_PATH" 2>/dev/null || true
  fi
}

_ot_log "starting pwd=$(pwd) log=${OT_LOG_PATH:-<stderr-only>}"

# Walk up looking for .opentrace/index.db (same logic as the CLI)
DB_PATH=""
CURRENT="$(pwd)"
for _ in $(seq 1 10); do
  if [ -f "$CURRENT/.opentrace/index.db" ]; then
    DB_PATH="$(cd "$CURRENT/.opentrace" && pwd)/index.db"
    break
  fi
  PARENT="$(dirname "$CURRENT")"
  [ "$PARENT" = "$CURRENT" ] && break
  # Stop at git repo root (use -e: .git is a file in worktrees, not a directory)
  [ -e "$CURRENT/.git" ] && break
  CURRENT="$PARENT"
done

# Escape values for safe JSON embedding
json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip())[1:-1], end="")'
}

if [ -z "$DB_PATH" ]; then
  _ot_log "db=not-found — will kick off background index"
  # No index found — start indexing in the background
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  if [ -n "$REPO_ROOT" ] && command -v uvx &>/dev/null; then
    _ot_log "background index: repo_root=$REPO_ROOT"
    nohup uvx opentraceai index "$REPO_ROOT" \
      >"${REPO_ROOT}/.opentrace-index.log" 2>&1 &
    _ot_log "background index: pid=$! log=${REPO_ROOT}/.opentrace-index.log"
  else
    _ot_log "background index: skipped (repo_root=$REPO_ROOT uvx=$(command -v uvx || echo missing))"
  fi

  NO_INDEX_MSG="OpenTrace: no index found — background indexing started. Tools will be available shortly."
  SAFE_SYSTEM=$(json_escape "${NO_INDEX_MSG}")

  cat <<EOF
{
  "systemMessage": "${SAFE_SYSTEM}"
}
EOF
  exit 0
fi

_ot_log "db=$DB_PATH"

# Get graph stats (best-effort, timeout 10s)
GRAPH_STATS=""
if command -v uvx &>/dev/null; then
  GRAPH_STATS=$(timeout 10 uvx opentraceai stats 2>/dev/null || true)
  _ot_log "stats: len=${#GRAPH_STATS}"
else
  _ot_log "stats: skipped (uvx missing)"
fi

# Check for CLI updates (best-effort, timeout 5s)
UPDATE_NOTICE=""
if command -v uvx &>/dev/null && command -v curl &>/dev/null; then
  INSTALLED_VERSION=$(timeout 5 uvx opentraceai --version 2>/dev/null | grep -oP '[\d]+\.[\d]+\.[\d]+' || true)
  LATEST_VERSION=$(timeout 5 curl -sS https://pypi.org/pypi/opentraceai/json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['info']['version'])" 2>/dev/null || true)
  _ot_log "versions: installed=$INSTALLED_VERSION latest=$LATEST_VERSION"
  if [ -n "$INSTALLED_VERSION" ] && [ -n "$LATEST_VERSION" ] && [ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]; then
    UPDATE_NOTICE="Update available: opentraceai ${INSTALLED_VERSION} → ${LATEST_VERSION}. Run /update to upgrade."
  fi
else
  _ot_log "update-check: skipped (uvx=$(command -v uvx || echo missing) curl=$(command -v curl || echo missing))"
fi


CONTEXT="You have access to OpenTrace, a knowledge graph that maps the user's system architecture, service relationships, and project metadata. Use your local tools (Read, Grep, Glob, etc.) for anything within the current codebase. Use OpenTrace when you need context beyond the local project — such as discovering upstream/downstream services, finding related classes or endpoints in other repositories, understanding deployment topology, looking up issues and tickets, or tracing how components connect across the system. When a question touches anything outside the current repo, consider checking OpenTrace. Specialist agents: @code-explorer, @dependency-analyzer, @find-usages, @explain-service. Commands: /explore <name>, /graph-status, /index."

if [ -n "$GRAPH_STATS" ]; then
  SYSTEM_MSG="OpenTrace is active — ${GRAPH_STATS}"
else
  SYSTEM_MSG="OpenTrace is active — index found at ${DB_PATH}. Run /graph-status or call get_stats to see what's indexed."
fi

if [ -n "$UPDATE_NOTICE" ]; then
  SYSTEM_MSG="${SYSTEM_MSG} | ${UPDATE_NOTICE}"
fi

# Show a debug marker so the user sees their env var is actually live.
if [ -n "$OT_DEBUG" ]; then
  if [ -n "$OT_LOG_PATH" ]; then
    SYSTEM_MSG="${SYSTEM_MSG} | debug: ${OT_LOG_PATH}"
  else
    SYSTEM_MSG="${SYSTEM_MSG} | debug: stderr only"
  fi
fi

_ot_log "systemMessage: ${SYSTEM_MSG}"

SAFE_CONTEXT=$(json_escape "${CONTEXT}")
SAFE_SYSTEM=$(json_escape "${SYSTEM_MSG}")

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${SAFE_CONTEXT}"
  },
  "systemMessage": "${SAFE_SYSTEM}"
}
EOF
