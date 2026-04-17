# OpenTrace Claude Code Plugin

[Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that exposes the OpenTrace knowledge graph for codebase exploration.

## Install

```bash
# From the repo root:
claude plugin marketplace add ./
claude plugin install opentrace-oss@opentrace-oss
```

Or reload after changes:

```bash
make plugin-reload    # from the repo root
```

## What It Does

Once installed, Claude Code gains access to your indexed codebase through graph query tools. Index a repo first (`opentraceai index .` or use `/index` in Claude Code), then ask questions about code structure, dependencies, and architecture.

The database is auto-discovered at `.opentrace/index.db` — no path configuration needed.

## Agents

| Agent | Description |
|-------|-------------|
| `@opentrace` | Default catch-all — any codebase question routed to the knowledge graph |
| `@code-explorer` | Explore code structure — find classes, functions, files, and their relationships |
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes |
| `@find-usages` | Find all callers, references, and usages of a component |
| `@explain-service` | Top-down walkthrough of how a service or module works |

## Commands

| Command | Description |
|---------|-------------|
| `/graph-status` | Show overview of indexed nodes by type, list repos and services |
| `/explore <name>` | Quick exploration of a named component in the graph |
| `/index` | Index (or re-index) the current project into the knowledge graph |
| `/interrogate` | Answer a question about the codebase without making changes |

## MCP Tools

All agents and skills use these tools from the `opentrace-oss` MCP server (backed by `uvx opentraceai mcp`):

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes of a specific type |
| `get_node` | Get full details of a single node by ID |
| `traverse_graph` | BFS traversal with direction and relationship filters |
| `get_stats` | Graph statistics — total nodes, edges, and breakdown by type |

## Structure

```
.claude-plugin/plugin.json  — Plugin manifest (name, version, description)
.mcp.json                   — MCP server config (stdio, runs opentraceai CLI)
agents/                     — Subagent definitions (.md with YAML frontmatter)
skills/                     — Skill definitions (directories with SKILL.md)
commands/                   — Slash command definitions (.md)
hooks/hooks.json            — Hook event bindings
scripts/                    — Shell scripts used by hooks (session-start, etc.)
```

## How It Works

1. **Session start hook** (`scripts/session-start.sh`) runs at session init, auto-discovers the index database at `.opentrace/index.db`, and injects graph context into the conversation.
2. **MCP server** (`uvx opentraceai mcp`) starts over stdio and exposes graph query tools.
3. **Agents** use the MCP tools to answer codebase questions — Claude Code routes user intent to the right agent based on the `description` field in each agent's frontmatter.

## Debug Mode

Set `OPENTRACE_DEBUG=1` before launching Claude Code to enable verbose hook logging:

```bash
OPENTRACE_DEBUG=1 claude
```

When enabled:
- All hook scripts write timestamped trace lines to `.opentrace/hook-debug.log` (auto-discovered next to `index.db`).
- The session-start systemMessage shows `| debug: <path>` so you can confirm it's active.
- Lines also go to stderr for real-time `tail -f` if you have the process visible.

Override the log path with `OPENTRACE_DEBUG_LOG=/path/to/file.log`.

The log file is gitignored via the root `*.log` pattern.

## Dev Mode

To run against a local checkout of the agent (e.g. when developing new MCP tools), override the MCP config to use `uv run` from the agent source directory:

```jsonc
// .mcp.json (dev override)
{
  "mcpServers": {
    "opentrace-oss": {
      "type": "stdio",
      "command": "uv",
      "args": [
        "run",
        "--directory", "/path/to/opentrace/agent",
        "opentraceai", "mcp"
      ],
      "description": "OpenTrace knowledge graph tools (dev)."
    }
  }
}
```

This uses the local agent source instead of the published PyPI package, so changes to `agent/` are reflected immediately without publishing.

## License

Apache License 2.0
