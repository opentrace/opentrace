# Graph Tools

The built-in chat agent has access to these MCP tools for querying the knowledge graph:

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes by type with optional property filters |
| `get_node` | Get full details of a single node by ID |
| `traverse_graph` | BFS traversal to discover connected nodes |
| `load_source` | Fetch source code for an indexed file or symbol |

## `search_graph`

Search nodes by name or property values. Returns matching nodes ranked by relevance.

## `list_nodes`

List all nodes of a given type, with optional filters on properties.

## `get_node`

Retrieve full details for a single node by its unique ID, including immediate neighbors.

## `traverse_graph`

Starting from a node, walk relationships in a specified direction (outgoing, incoming, or both) to discover connected components.

## `load_source`

Fetch the source code content for a file or symbol node, using registered GitHub/GitLab integrations.
