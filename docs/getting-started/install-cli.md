# CLI

Install the `opentraceai` command-line tool to index repositories and run an MCP server from your terminal.

## Prerequisites

- **Python 3.12+**
- **[`uv`](https://docs.astral.sh/uv/)** recommended — makes `uvx` and isolated installs trivial. See the [`uv` install guide](https://docs.astral.sh/uv/getting-started/installation/).

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
    opentrace index .
    ```

    Best for: daily use from any shell. This is the recommended permanent install.

=== "pip"

    Install into your current Python environment (ideally a venv).

    ```bash
    pip install opentraceai
    opentrace index .
    ```

    Best for: an environment you already manage with pip.

=== "pipx"

    Install globally in an isolated environment. Similar to `uv tool install` but via `pipx`.

    ```bash
    pipx install opentraceai
    opentrace index .
    ```

    Best for: if you already use `pipx` and don't want to install `uv`.

## Using It

The package installs as `opentraceai`, but the CLI binary is `opentrace` (shorter alias — `opentraceai` also works).

```bash
opentrace index /path/to/repo   # index a repo into a knowledge graph
opentrace mcp                   # start an MCP server over stdio
opentrace --help                # see all commands
```

The graph is stored at `.opentrace/index.db` at the repo root. Every `opentrace` command walks up from your current directory to find it, so you can run commands from any subdirectory.

## What Next

- **Connect an MCP client?** → [MCP Server](install-mcp.md)
- **Run it inside Claude Code?** → [Claude Code Plugin](install-plugin.md) (installs the CLI automatically)
- **Something not working?** → [Troubleshooting](troubleshooting.md)
- **See what the graph exposes** → [Graph Tools](../reference/graph-tools.md)

---

*Other install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [MCP](install-mcp.md) · [Plugin](install-plugin.md) · [Source](../development/setup.md)*
