# OpenTrace Claude Code Plugin

Gives Claude Code access to an indexed codebase knowledge graph via MCP.

## Setup

### 1. Index your codebase

From your project directory:

```bash
uvx opentraceai index
```

This creates a `.opentrace/index.db` knowledge graph in your project root. You can also pass a path explicitly: `uvx opentraceai index /path/to/repo`.

### 2. Install the plugin

#### Claude Code

Add the OpenTrace marketplace and install the plugin:

```bash
claude plugin marketplace add https://github.com/opentrace/opentrace
claude plugin install opentrace-oss@opentrace-oss
```

#### Gemini

```bash
gemini mcp add --scope project opentraceai uvx opentraceai mcp
```

#### GitHub Copilot (VS Code)

Add to `.vscode/mcp.json` in your project root (create it if it doesn't exist):

```json
{
  "servers": {
    "opentrace-oss": {
      "type": "stdio",
      "command": "uvx",
      "args": ["opentraceai", "mcp"]
    }
  }
}
```

The MCP server auto-discovers `.opentrace/index.db` by walking up from the current directory.

#### Other MCP clients (local LLMs, custom tooling)

Configure your MCP client to run the stdio server directly:

```bash
uvx opentraceai mcp --db /path/to/repo/.opentrace/index.db
```

If your client launches the server from the project directory, the `--db` flag can be omitted and the database will be auto-discovered.

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
        "--db", "/path/to/repo/.opentrace/index.db"
      ],
      "description": "OpenTrace knowledge graph tools (dev)."
    }
  }
}
```

This uses the local agent source instead of the published PyPI package, so changes to `agent/` are reflected immediately without publishing.
