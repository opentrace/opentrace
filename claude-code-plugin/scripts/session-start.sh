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
  # No index found — start indexing in the background
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  if [ -n "$REPO_ROOT" ] && command -v uvx &>/dev/null; then
    nohup uvx opentraceai index "$REPO_ROOT" \
      >"${REPO_ROOT}/.opentrace-index.log" 2>&1 &
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

# Get graph stats (best-effort, timeout 10s)
GRAPH_STATS=""
if command -v uvx &>/dev/null; then
  GRAPH_STATS=$(timeout 10 uvx opentraceai stats 2>/dev/null || true)
fi

CONTEXT="You have access to OpenTrace, a knowledge graph that maps the user's system architecture, service relationships, and project metadata. Use your local tools (Read, Grep, Glob, etc.) for anything within the current codebase. Use OpenTrace when you need context beyond the local project — such as discovering upstream/downstream services, finding related classes or endpoints in other repositories, understanding deployment topology, looking up issues and tickets, or tracing how components connect across the system. When a question touches anything outside the current repo, consider checking OpenTrace. Specialist agents: @code-explorer, @dependency-analyzer, @find-usages, @explain-service. Commands: /explore <name>, /graph-status, /index."

if [ -n "$GRAPH_STATS" ]; then
  SYSTEM_MSG="OpenTrace is active — ${GRAPH_STATS}"
else
  SYSTEM_MSG="OpenTrace is active — index found at ${DB_PATH}. Run /graph-status or call get_stats to see what's indexed."
fi

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
