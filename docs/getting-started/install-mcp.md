# MCP Server

`opentrace mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Any MCP-compatible client (Claude Code, Cursor, Copilot, Gemini, etc.) can connect to it to query the knowledge graph.

## Prerequisites

- **[`uv`](https://docs.astral.sh/uv/)** — the examples below use `uvx`, which downloads and caches `opentraceai` on first use with no global install needed. See the [`uv` install guide](https://docs.astral.sh/uv/getting-started/installation/).
- A **knowledge graph** built with `opentrace index` — see [CLI](install-cli.md).

## Claude Code

Use the [Claude Code Plugin](install-plugin.md) — it configures the MCP server automatically.

## Gemini CLI

```bash
gemini mcp add opentraceai uvx opentraceai mcp
```

## Other Clients (Cursor, Copilot, etc.)

Add the following to your client's MCP config:

```json
{
    "mcpServers": {
        "opentrace": {
            "type": "stdio",
            "command": "uvx",
            "args": ["opentraceai", "mcp"]
        }
    }
}
```

## What Next

- **What tools does the MCP server expose?** → [Graph Tools](../reference/graph-tools.md)
- **Something not working?** → [Troubleshooting](troubleshooting.md)

---

*Other install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [MCP](install-mcp.md) · [Plugin](install-plugin.md) · [Source](../development/setup.md)*
