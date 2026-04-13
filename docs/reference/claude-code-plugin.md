# Claude Code Plugin

OpenTrace ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that connects Claude to the OpenTrace knowledge graph. Once installed, Claude can explore your indexed codebase — find components, trace dependencies, and answer architecture questions.

!!! info "New here?"
    This page is the **reference** for what's inside the plugin. For install instructions, see [Claude Code Plugin install](../getting-started/install-plugin.md).

## How It Works

The plugin runs an MCP server (via `opentraceai mcp`) that gives Claude access to the knowledge graph stored in `.opentrace/index.db`. The database is auto-discovered by walking up from the current directory to the git root.

## Agents

Agents are specialized assistants you can invoke with `@agent-name` in Claude Code.

| Agent | Description |
|-------|-------------|
| `@opentrace` | General-purpose — any codebase question (default) |
| `@code-explorer` | Explore code structure, files, directories, and their relationships |
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes |
| `@explain-service` | Top-down explanation of a service or major component |
| `@find-usages` | Find all callers, references, and usages of a component |

## Commands

Commands are slash-invoked actions available in Claude Code.

| Command | Description |
|---------|-------------|
| `/explore <name>` | Quick exploration of a named component in the graph |
| `/graph-status` | Show overview of indexed nodes by type |
| `/index` | Index or re-index the current project |
| `/interrogate` | Answer a question about the codebase (read-only) |
| `/update` | Check for and install CLI updates |

## Graph Tools

The plugin exposes these MCP tools to Claude:

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes by type with optional property filters |
| `get_node` | Get full details of a single node by ID |
| `traverse_graph` | BFS traversal to discover connected nodes |
| `get_stats` | Node and edge counts by type |

## Configuration

The plugin source lives in `claude-code-plugin/` in the repository root. See the `CLAUDE.md` file in that directory for details on plugin structure, versioning, and agent development.
