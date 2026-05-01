# OpenTrace OpenCode Plugin

[OpenCode](https://opencode.ai) plugin that exposes the OpenTrace knowledge graph as native tools — search, traversal, source reads, impact analysis — so the model can navigate your codebase without you feeding it files.

## Install

The plugin runs inside OpenCode's own Bun runtime and shells out to the [`opentraceai`](https://pypi.org/project/opentraceai/) CLI for graph queries.

### Prerequisites

- **[OpenCode](https://opencode.ai)** installed (`opencode --version`).
- **[`uv`](https://docs.astral.sh/uv/)** installed — the plugin invokes `uvx opentraceai` (or any installed equivalent) for graph queries.

### Register the plugin

Add the plugin to your OpenCode config (`~/.config/opencode/opencode.json` for global, or `.opencode/opencode.json` for per-project).

**Recommended — npm package name:**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@opentrace/opencode"
  ]
}
```

OpenCode resolves the package and loads the bundled artifact. Append `@<version>` to pin a specific release.

**Curl into the plugin directory** — for setups where editing `opencode.json` is awkward:

```sh
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://cdn.jsdelivr.net/npm/@opentrace/opencode/dist/index.js \
  -o ~/.config/opencode/plugins/opentrace.js
```

## Usage

Just ask OpenCode to index your project. You can also ask it to index any other repo — local or remote — and it'll pull it into the graph. Each project directory gets its own graph.

## Tools

The plugin registers 9 native tools (all prefixed `opentrace_`).

| Tool | Description |
|------|-------------|
| `opentrace_source_search` | Symbol-level search across indexed code |
| `opentrace_semantic_search` | Embedding-based search over node descriptions |
| `opentrace_source_read` | Read source for a graph node by ID |
| `opentrace_source_grep` | Grep across indexed source content |
| `opentrace_repo_index` | Index a local path or remote git URL |
| `opentrace_find_usages` | Find callers and references of a component |
| `opentrace_impact_analysis` | Blast radius analysis for a change |
| `opentrace_graph_explore` | BFS traversal with direction and depth controls |
| `opentrace_graph_stats` | Node and edge counts by type |

## Configuration

Plugin options pass as the second element of the plugin tuple in `opencode.json`:

```jsonc
{
  "plugin": [
    ["@opentrace/opencode", {
      "timeout": 10000,
      "indexTimeout": 1800000,
      "debug": false,
      "debugFile": "~/.opentrace/debug.log"
    }]
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | `10000` | Timeout (ms) for normal CLI calls |
| `indexTimeout` | `1800000` | Timeout (ms) for `index` / `fetch-and-index`; `0` = no timeout |
| `debug` | `false` | Enable debug logging |
| `debugFile` | `~/.opentrace/debug.log` | Override the debug log path |

## Auth

For private-repo indexing the plugin resolves a token in this order:

1. OpenCode-managed credential (only for known hosts: `github.com`, `gitlab.com`)
2. Host-specific env var (`GITHUB_TOKEN`, `GITLAB_TOKEN`)
3. `OPENTRACE_GIT_TOKEN` (cross-host override for self-hosted GitHub Enterprise, GitLab, Gitea)

Public repos work without any auth.

## License

Apache License 2.0
