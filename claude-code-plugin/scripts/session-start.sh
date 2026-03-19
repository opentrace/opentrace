#!/usr/bin/env bash
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
