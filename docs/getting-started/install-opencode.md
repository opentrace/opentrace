# OpenCode Plugin

The OpenTrace plugin gives [OpenCode](https://opencode.ai) real codebase awareness — OpenCode can search the graph, trace dependencies, and read source by graph node without you feeding it files by hand.

## Prerequisites

- **[OpenCode](https://opencode.ai)** installed and working (`opencode --version`).
- **[`uv`](https://docs.astral.sh/uv/)** installed — the plugin shells out to `uvx opentraceai` for graph queries. See the [`uv` install guide](https://docs.astral.sh/uv/getting-started/installation/).

!!! tip "Why `uv`?"
    The plugin doesn't bundle a Python environment. Instead it invokes `uvx opentraceai`, which lets `uv` handle Python version, dependencies, and caching automatically. If `uv` isn't installed, the graph CLI can't run and the tools will return install guidance instead of results.

## Install

Add the plugin to your OpenCode config — globally at `~/.config/opencode/opencode.json` or per-project at `.opencode/opencode.json`:

=== "npm"

    OpenCode resolves the package and runs the bundled artifact. No build step on your side.

    ```jsonc
    {
      "$schema": "https://opencode.ai/config.json",
      "plugin": [
        "@opentrace/opencode"
      ]
    }
    ```

=== "Curl into plugin dir"

    Drop the bundled file straight into OpenCode's auto-loaded plugin directory. Useful when you can't or don't want to edit `opencode.json`:

    ```sh
    mkdir -p ~/.config/opencode/plugins
    curl -fsSL https://cdn.jsdelivr.net/npm/@opentrace/opencode/dist/index.js \
      -o ~/.config/opencode/plugins/opentrace.js
    ```

=== "Local source (dev)"

    For developing the plugin itself — `bun` reloads the source each session, no rebuild required.

    ```jsonc
    {
      "$schema": "https://opencode.ai/config.json",
      "plugin": [
        ["file:///absolute/path/to/opentrace/plugins/opencode/src/index.ts", { "autoIndex": false }]
      ]
    }
    ```

Restart OpenCode (or start a new session) and the plugin is active.

To pin a specific version, append `@<version>`: `"@opentrace/opencode@<version>"` for npm, or `https://cdn.jsdelivr.net/npm/@opentrace/opencode@<version>/dist/index.js` for the curl path.

## First Session

When OpenCode starts in a directory with an indexed graph (`.opentrace/index.db`), the plugin's system-prompt hook injects graph context — node counts, indexed repos — so the model knows what's available before you ask the first question.

If the repo isn't indexed yet, ask OpenCode to run the `opentrace_repo_index` tool (or run `opentraceai index .` from a shell). The plugin auto-discovers the database by walking up from the current directory to the git root, so any subdirectory works.

## What You Get

- **9 native tools** — `opentrace_source_search`, `opentrace_semantic_search`, `opentrace_source_read`, `opentrace_source_grep`, `opentrace_repo_index`, `opentrace_find_usages`, `opentrace_impact_analysis`, `opentrace_graph_explore`, `opentrace_graph_stats`
- **System-prompt injection** — graph awareness in every chat turn, cached 60s
- **Tool-execute hooks** — augments grep/glob with graph context; flags blast radius on edit/write
- **Auth hook** — stores GitHub/GitLab PATs via OpenCode's keychain for private-repo indexing

For the full reference, see [OpenCode Plugin reference](../reference/opencode-plugin.md).

## What Next

- **Full plugin reference** → [OpenCode Plugin](../reference/opencode-plugin.md)
- **CLI (same tool, without OpenCode)** → [CLI](install-cli.md)
- **Plugin installed but tools missing?** → [Troubleshooting](troubleshooting.md)

---

*Other install paths: [Browser](install-browser.md) · [CLI](install-cli.md) · [Claude Code Plugin](install-plugin.md) · [Source](../development/setup.md)*
