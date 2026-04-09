# Graph Tools

The OpenTrace knowledge graph can be queried through MCP tools, available to both the built-in chat agent and the Claude Code plugin.

## Tools

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes by type with optional property filters |
| `get_node` | Get full details of a single node by ID |
| `traverse_graph` | BFS traversal to discover connected nodes |
| `load_source` | Fetch source code for an indexed file or symbol |
| `get_stats` | Node and edge counts by type |

## Node Types

The knowledge graph contains the following node types:

| Category | Types |
|----------|-------|
| Code | Class, Module, Function, File, Directory |
| Infrastructure | Service, Cluster, Namespace, Deployment |
| Observability | InstrumentedService, Span, Log, Metric |
| Data | Database, DBTable, Endpoint |
| Organization | Repo, Repository |
