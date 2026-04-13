# CLI

Install the `opentraceai` command-line tool to index repositories and run an MCP server from your terminal.

## Prerequisites

- **Python 3.12+**
- **[`uv`](https://docs.astral.sh/uv/)** recommended — makes `uvx` and isolated installs trivial. Install with `curl -LsSf https://astral.sh/uv/install.sh | sh`.

## Install

=== "uvx (try without installing)"

    Run OpenTrace without installing it globally — `uvx` downloads and caches it on first use.

    ```bash
    uvx opentraceai index .
    ```

    Best for: kicking the tires, or using it from a CI job.

=== "uv tool (recommended)"

    Install globally in an isolated environment managed by `uv`. Re-running the command upgrades it in place.

    ```bash
    uv tool install opentraceai --upgrade
    opentraceai index .
    ```

    Best for: daily use from any shell. This is the recommended permanent install.

=== "pip"

    Install into your current Python environment (ideally a venv).

    ```bash
    pip install opentraceai
    opentraceai index .
    ```

    Best for: an environment you already manage with pip.

=== "pipx"

    Install globally in an isolated environment. Similar to `uv tool install` but via `pipx`.

    ```bash
    pipx install opentraceai
    opentraceai index .
    ```

    Best for: if you already use `pipx` and don't want to install `uv`.

## Using It

```bash
opentraceai index /path/to/repo   # index a repo into a knowledge graph
opentraceai mcp                   # start an MCP server over stdio
opentraceai --help                # see all commands
```

The graph is stored at `.opentrace/index.db` at the repo root. Every `opentraceai` command walks up from your current directory to find it, so you can run commands from any subdirectory.

## MCP Server

`opentraceai mcp` starts a Model Context Protocol server over stdio. Any MCP-compatible client (Claude Code, Cursor, etc.) can connect to it to query the graph.

If you're using Claude Code, the [plugin](install-plugin.md) handles this for you.

## What Next

- **Run it inside Claude Code?** → [Claude Code Plugin](install-plugin.md) (installs the CLI automatically)
- **Something not working?** → [Troubleshooting](troubleshooting.md)
- **See what the graph exposes** → [Graph Tools](../reference/graph-tools.md)

---

*Other install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [Plugin](install-plugin.md) · [Source](../development/setup.md)*
