# Pick Your Path

OpenTrace has four ways in. Pick the one that matches what you want to do.

| You want to…                          | Use                              | Time       | Guide |
|---------------------------------------|----------------------------------|------------|-------|
| See what OpenTrace is                 | Browser                          | 30 seconds | [Browser](install-browser.md) |
| Give Claude Code codebase awareness   | Claude Code plugin               | 2 minutes  | [Plugin](install-plugin.md) |
| Index repos from a terminal           | CLI (`uvx` / `pip` / `pipx`)     | 2 minutes  | [CLI](install-cli.md) |
| Hack on OpenTrace itself              | Source build                     | 5 minutes  | [Development Setup](../development/setup.md) |

## One-Liners

If you already know which path you want:

=== "Browser"

    Open [**oss.opentrace.ai**](https://oss.opentrace.ai) and paste a repo URL. Done.

=== "Claude Code Plugin"

    ```bash
    claude plugin marketplace add https://github.com/opentrace/opentrace
    claude plugin install opentrace-oss@opentrace-oss
    ```

    Requires [`uv`](https://docs.astral.sh/uv/). The plugin auto-indexes your repo on session start.

=== "CLI"

    ```bash
    uvx opentraceai index .          # try without installing
    # or
    pip install opentraceai
    ```

    Requires Python 3.12+.

=== "Source"

    ```bash
    git clone https://github.com/opentrace/opentrace.git
    cd opentrace
    make install
    make ui
    ```

    Requires Node 22+ and Python 3.12+ with `uv`.

## What Happens When You Index

Regardless of path, when OpenTrace indexes a repo it will:

1. Fetch or read the source code.
2. Parse every file using tree-sitter WASM grammars.
3. Extract symbols (classes, functions, imports) and call relationships.
4. Build a knowledge graph in an embedded LadybugDB instance.
5. Make the graph available for exploration and querying.

## Something Not Working?

See [Troubleshooting](troubleshooting.md).
