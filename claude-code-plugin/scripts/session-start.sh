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
# Checks for an otindex.db in common locations and tells Claude about the graph.

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

# Get basic stats if the MCP server is queryable (best-effort)
DB_SIZE=$(du -sh "$DB_PATH" 2>/dev/null | cut -f1 || echo "unknown")

cat <<EOF
{
  "additionalContext": "OpenTrace knowledge graph is available (index: ${DB_PATH}, size: ${DB_SIZE}). Use the @code-explorer, @dependency-analyzer, @find-usages, or @explain-service agents to query the indexed codebase structure. Use the /explore or /graph-status commands for quick lookups. The graph contains indexed services, classes, functions, files, and their relationships — prefer it over raw Grep/Glob when answering structural or architectural questions."
}
EOF
