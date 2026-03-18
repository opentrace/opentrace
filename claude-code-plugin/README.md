# OpenTrace Claude Code Plugin

Gives Claude Code access to an indexed codebase knowledge graph via MCP.

## Setup

### 1. Index a codebase

```bash
uvx opentraceai index /path/to/repo
```

This creates an `otindex.db` database in the current directory.

### 2. Install the plugin

The `.mcp.json` is configured to run `uvx opentraceai mcp --db ./otindex.db`.
Update the `--db` path to point at your indexed database.

## Dev mode

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
        "opentrace", "mcp",
        "--db", "/path/to/otindex.db"
      ],
      "description": "OpenTrace knowledge graph tools (dev)."
    }
  }
}
```

This uses the local agent source instead of the published PyPI package, so changes to `agent/` are reflected immediately without publishing.
