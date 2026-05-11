Show an overview of what's indexed in the OpenTrace knowledge graph.

1. Call `get_stats` to get total node count, total edge count, and counts by node type.
2. Present a summary table showing:
   - Node type and count for each type that has at least 1 node
   - Totals for nodes and edges
3. List all repositories by calling `list_nodes` with type "Repository" (also try "Repo" if empty).
4. List all services by calling `list_nodes` with type "Service".

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
