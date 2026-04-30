# OpenCode Plugin

OpenTrace ships an [OpenCode](https://opencode.ai) plugin that exposes the OpenTrace knowledge graph as native tools. Once registered, OpenCode can search the graph, traverse dependencies, read source by graph node, and analyze blast radius — without you feeding it files manually.

!!! info "New here?"
    This page is the **reference** for what's inside the plugin. For install instructions, see [OpenCode Plugin install](../getting-started/install-opencode.md).

## How It Works

The plugin runs inside OpenCode's own Bun runtime and shells out to the `opentraceai` CLI for graph queries. The graph database is auto-discovered at `.opentrace/index.db` by walking up from the current directory to the git root.

Unlike the Claude Code plugin (which uses MCP over stdio), the OpenCode plugin registers tools as native OpenCode tools and uses OpenCode's own hook system for system-prompt injection and tool-execute interception.

## Tools

All tool names are prefixed `opentrace_` to avoid collisions with built-in OpenCode tools.

| Tool | Description |
|------|-------------|
| `opentrace_source_search` | Symbol-level search across indexed code |
| `opentrace_semantic_search` | Embedding-based search over node descriptions |
| `opentrace_source_read` | Read source for a graph node by ID |
| `opentrace_source_grep` | Grep across indexed source content |
| `opentrace_repo_index` | Index a local path or remote git URL into the graph |
| `opentrace_find_usages` | Find all callers and references of a component |
| `opentrace_impact_analysis` | Blast radius analysis for a proposed change |
| `opentrace_graph_explore` | BFS traversal with direction and depth controls |
| `opentrace_graph_stats` | Node and edge counts by type |

## Hooks

The plugin registers three OpenCode hooks:

| Hook | Purpose |
|------|---------|
| `experimental.chat.system.transform` | Injects graph context (indexed repos, node counts, suggested tools) into the system prompt on every chat turn. Cached 60 seconds; bounded by a 3-second timeout so it never blocks the UI |
| `tool.execute.after` | Two interceptors — augments `grep`/`glob` results with graph context (related nodes, file→symbol mapping) and flags blast radius after `edit`/`write` |
| `auth` | Stores git host PATs (`github.com`, `gitlab.com`) via OpenCode's keychain for private-repo indexing |

## Configuration

Plugin options pass as the second tuple element in `opencode.json`:

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
| `indexTimeout` | `1800000` | Timeout (ms) for `index` / `fetch-and-index`. Indexing a large repo can take much longer than a regular call. Set to `0` to wait indefinitely |
| `debug` | `false` | Enable debug logging to the file at `debugFile` |
| `debugFile` | `~/.opentrace/debug.log` | Override the debug log path |

## Auth

For private-repo indexing the plugin resolves a token in this order:

1. **OpenCode-managed credential** — used only for known git hosts (`github.com`, `gitlab.com`). The keychain stores one token at a time and doesn't record which provider it came from, so unknown hosts fall through to the env-var path.
2. **Host-specific env var** — `GITHUB_TOKEN` or `GITLAB_TOKEN`.
3. **`OPENTRACE_GIT_TOKEN`** — explicit cross-host override for self-hosted GitHub Enterprise, GitLab, Gitea, etc.

CI-style `fetch-and-index` runs without any stored auth still work for public repos — the CLI just doesn't receive a `--token` flag.

## Source

The plugin source lives in `plugins/opencode/` in the repository root. See the README in that directory for plugin structure, hooks, and development notes.
