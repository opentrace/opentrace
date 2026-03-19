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
# Checks for an otindex.db in common locations, runs `opentraceai stats` to
# show what's indexed, and tells Claude about the available tools.

set -euo pipefail

# Look for the index database
DB_PATH=""
for candidate in "./otindex.db" "../otindex.db" "../../otindex.db"; do
  if [ -f "$candidate" ]; then
    DB_PATH="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
    break
  fi
done

if [ -z "$DB_PATH" ]; then
  # No index found — nothing to inject
  exit 0
fi

# Get graph stats (best-effort, timeout 10s)
GRAPH_STATS=""
if command -v uvx &>/dev/null; then
  GRAPH_STATS=$(timeout 10 uvx opentraceai stats --db "$DB_PATH" 2>/dev/null || true)
fi

# Escape values for safe JSON embedding
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

SAFE_DB_PATH=$(json_escape "${DB_PATH}")

if [ -n "$GRAPH_STATS" ]; then
  SAFE_STATS=$(json_escape "${GRAPH_STATS}")
  CONTEXT="OpenTrace knowledge graph is available (${SAFE_STATS}). The graph indexes files, directories, classes, functions, modules, services, and their relationships — not just code symbols. Use @opentrace as the default agent for ANY codebase question (browsing, searching, architecture, dependencies). Specialist agents: @code-explorer, @dependency-analyzer, @find-usages, @explain-service. Commands: /explore <name>, /graph-status. Prefer the graph over ls/find/Glob for structural questions."
else
  CONTEXT="OpenTrace knowledge graph is available (index: ${SAFE_DB_PATH}). Use @opentrace as the default agent for ANY codebase question (browsing, searching, architecture, dependencies). Specialist agents: @code-explorer, @dependency-analyzer, @find-usages, @explain-service. Commands: /explore <name>, /graph-status. Prefer the graph over ls/find/Glob for structural questions. Call get_stats to see what's indexed."
fi

cat <<EOF
{
  "additionalContext": "${CONTEXT}"
}
EOF
