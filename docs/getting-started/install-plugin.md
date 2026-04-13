# Claude Code Plugin

The OpenTrace plugin gives [Claude Code](https://docs.anthropic.com/en/docs/claude-code) real codebase awareness — Claude can search the graph, trace dependencies, and explain services without you feeding it files by hand.

## Prerequisites

- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** installed and working (`claude --version`).
- **[`uv`](https://docs.astral.sh/uv/)** installed — the plugin uses `uvx` to run the `opentraceai` MCP server. See the [`uv` install guide](https://docs.astral.sh/uv/getting-started/installation/).

!!! tip "Why `uv`?"
    The plugin doesn't bundle a Python environment. Instead it invokes `uvx opentraceai mcp`, which lets `uv` handle Python version, dependencies, and caching automatically. If `uv` isn't installed, the MCP server can't start and Claude won't see any graph tools.

## Install

=== "Shell (`claude plugin`)"

    ```bash
    claude plugin marketplace add https://github.com/opentrace/opentrace
    claude plugin install opentrace-oss@opentrace-oss
    ```

=== "Inside Claude Code (`/plugin`)"

    ```text
    /plugin marketplace add https://github.com/opentrace/opentrace
    /plugin install opentrace-oss@opentrace-oss
    ```

That's the whole install. Restart Claude Code (or start a new session) and the plugin is active.

## First Session

When you start a Claude Code session inside a git repo, the plugin **automatically kicks off a background index**. You don't need to run anything manually — by the time you ask your first question, the graph is usually ready.

If you want explicit control:

```text
/index           # index (or re-index) the current repo
/graph-status    # see what's in the graph
/interrogate     # ask a codebase question without making changes
/explore <name>  # quick exploration of a named component
```

## What You Get

- **5 agents** — `@opentrace` (default), `@code-explorer`, `@dependency-analyzer`, `@find-usages`, `@explain-service`
- **4 slash commands** — `/index`, `/graph-status`, `/explore`, `/interrogate`
- **5 MCP tools** — `search_graph`, `list_nodes`, `get_node`, `traverse_graph`, `get_stats`

For the full list with descriptions, see the [Claude Code Plugin reference](../reference/claude-code-plugin.md).

## Where the Graph Lives

The plugin stores the graph at `.opentrace/index.db` in your repo. It's auto-discovered by walking up from your current directory to the git root, so any subdirectory works.

You can safely `.gitignore` the `.opentrace/` directory — it's rebuildable from source.

## What Next

- **Full plugin reference** → [Claude Code Plugin](../reference/claude-code-plugin.md)
- **CLI (same tool, without Claude)** → [CLI](install-cli.md)
- **Plugin installed but tools missing?** → [Troubleshooting](troubleshooting.md)

---

*Other install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [Plugin](install-plugin.md) · [Source](../development/setup.md)*
