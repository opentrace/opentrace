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

## Optional extras

Some commands require optional dependency groups. Install them via the bracket syntax (`opentraceai[graph]`) or by passing `--extra` flags to `uv sync` if you're working from source.

| Extra | What it pulls in | Required for |
|---|---|---|
| `graph` | `networkx`, `markitdown[all]`, `faster-whisper`, `yt-dlp`, `anthropic`, `openai` | Doc ingestion (PDF/DOCX/MD/HTML/...), entity extraction, community detection, vault compilation, audio/video transcription, URL fetching |
| `graph-leiden` | `graspologic` (Python < 3.13) | The Leiden community detection algorithm. Without it, `opentraceai cluster` falls back to Louvain — slightly different output, not broken |
| `graph-watch` | `watchdog` | `opentraceai watch` |

The bare install gives you the **structural code indexer** + retrieval primitives (`search`, `traverse`, `find_path`, etc.) over a code repo. Add `graph` as soon as you want to ingest documents, build vaults, or run LLM extraction.

=== "uv tool — bracket syntax"

    ```bash
    uv tool install --upgrade 'opentraceai[graph,graph-watch]'
    ```

=== "From source"

    ```bash
    git clone https://github.com/opentrace/opentrace
    cd opentrace/agent
    uv sync --extra graph --extra graph-watch --extra graph-leiden
    ```

=== "pip"

    ```bash
    pip install 'opentraceai[graph,graph-watch]'
    ```

If you skip the extras and run a feature that needs one, the CLI errors out with an actionable hint pointing at the right install command.

## Using It

The package installs as `opentraceai`, but the CLI binary is `opentrace` (shorter alias — `opentraceai` also works).

```bash
opentrace index /path/to/repo                          # index a code repo
opentrace index /path/to/repo --wiki                   # also ingest docs: entities + doc corpus
opentrace index /path/docs foo --wiki                  # index docs into a vault named foo
opentrace vault ingest /path/docs                      # docs-only: no repo required
opentrace vault list                                   # vaults visible from current project
opentrace cluster && opentrace analyze                 # community detection + cross-cutting analysis
opentrace mcp                                          # start an MCP server over stdio
opentrace --help                                       # see all commands
```

The graph is stored at `.opentrace/index.db` at the repo root. Every `opentrace` command walks up from your current directory to find it, so you can run commands from any subdirectory.

## What Next

- **Index a repo end-to-end** → [Indexing](indexing.md)
- **Compile a wiki vault** → [Wiki & Vaults](wiki.md)
- **Connect an MCP client?** → [MCP Server](install-mcp.md)
- **Run it inside Claude Code?** → [Claude Code Plugin](install-plugin.md) (installs the CLI automatically)
- **Something not working?** → [Troubleshooting](troubleshooting.md)
- **See what the graph exposes** → [Graph Tools](../reference/graph-tools.md)

---

*Other install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [MCP](install-mcp.md) · [Plugin](install-plugin.md) · [Source](../development/setup.md)*
