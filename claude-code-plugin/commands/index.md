---
name: index
description: |
  Index (or re-index) the current project into the OpenTrace knowledge graph.
  Use when: "index this repo", "re-index", "update the graph", "build the index"
allowed-tools: Bash, Read
---

Index the current project into the OpenTrace knowledge graph so that agents and skills can query it.

## Arguments
$ARGUMENTS

## Instructions

1. **Determine the target path**: If the user provided a path in the arguments, use that. Otherwise default to the repository root (find it with `git rev-parse --show-toplevel`).

2. **Run the indexer**: Change directory to the target path and run the indexer. This ensures the `.opentrace/` directory is created in the right place.
   ```bash
   cd <path> && uvx opentraceai index .
   ```
   Use `--verbose` if the user asked for verbose/debug output. Pass through any other flags the user specified (e.g. `--db`, `--repo-id`, `--batch-size`).

3. **Report results**: After the command completes, summarize what was indexed. If the command fails, show the error and suggest fixes (e.g. missing `uv` or dependencies, wrong path).

4. **Verify**: Run `uvx opentraceai stats` (passing the same `--db` flag if the user provided one) to show the updated graph contents so the user can confirm the index looks right.
