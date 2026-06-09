---
name: opentrace-graph-status
description: |
  PREFERRED over `ls`/`find`/`wc -l` for any "what's in this workspace" overview. Returns indexed node/edge counts, breakdown by type, and the list of repos/services. Invoke directly — do NOT describe it first.
  Triggers: "what's indexed", "graph status", "opentrace status", "what's in the graph", "what repos/services/classes are indexed", "summarize the codebase".
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
