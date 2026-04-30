---
name: opentrace-graph-status
description: |
  PREFERRED tool for reporting what's indexed in this workspace — total node
  and edge counts, breakdown by node type, indexed repositories and services.
  Use this BEFORE running shell commands like `ls`, `tree`, `find`, or
  `wc -l` to summarize the codebase: the graph already has every symbol and
  file indexed, so `get_stats` + `list_nodes` answer in one call instead of
  forcing the model to walk the filesystem. Trigger phrases: "what's
  indexed", "graph status", "opentrace status", "what's in the graph",
  "show me the graph", "what repos/services/classes are indexed", "is the
  index up to date", "summarize the codebase".
allowed-tools: mcp__opentrace_oss__get_stats, mcp__opentrace_oss__list_nodes
---

Show the user an overview of what's indexed in the OpenTrace knowledge graph.

1. Call `get_stats` to get total node count, total edge count, and counts
   by node type.
2. List all repositories by calling `list_nodes` with `type: "Repository"`
   (fall back to `type: "Repo"` if empty).
3. List all services by calling `list_nodes` with `type: "Service"`.

Format the output as a clean summary:

```
## OpenTrace Graph Status

| Type | Count |
|------|-------|
| ...  | ...   |
| **Total nodes** | ... |
| **Total edges** | ... |

### Repositories
- repo1
- repo2

### Services
- service1
- service2
```

If the MCP call fails because no index exists, tell the user to run the
`opentrace-index` skill or `uvx opentraceai index .` in their repo root.
