# OpenTrace OpenCode Plugin

[OpenCode](https://opencode.ai) plugin that exposes the OpenTrace knowledge graph as native tools — search, traversal, source reads, impact analysis — so the model can navigate your codebase without you feeding it files.

## Install

The plugin runs inside OpenCode's own Bun runtime and shells out to the [`opentraceai`](https://pypi.org/project/opentraceai/) CLI for graph queries.

### Prerequisites

- **[OpenCode](https://opencode.ai)** installed (`opencode --version`).
- **[`uv`](https://docs.astral.sh/uv/)** installed — the plugin invokes `uvx opentraceai` (or any installed equivalent) for graph queries.

### Register the plugin

Add the plugin to your OpenCode config (`~/.config/opencode/opencode.json` for global, or `.opencode/opencode.json` for per-project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opentrace-opencode"
  ]
}
```

If you have the source checked out locally and want to run against it directly:

```jsonc
{
  "plugin": [
    ["file:///absolute/path/to/plugins/opencode/src/index.ts", { "autoIndex": false }]
  ]
}
```

## What It Does

Once registered, OpenCode gains 9 native tools (all prefixed `opentrace_`) plus three hooks that inject graph awareness into every session.

The graph database is auto-discovered at `.opentrace/index.db` — walk up from the current directory to the git root. Index a repo first with `opentraceai index .` or via the `opentrace_repo_index` tool.

## Tools

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

## Hooks

| Hook | Purpose |
|------|---------|
| `experimental.chat.system.transform` | Injects graph context (indexed repos, node counts) into the system prompt. Cached 60s, 3s timeout |
| `tool.execute.after` | Augments grep/glob results with graph context; flags edit/write impact |
| `auth` | Stores git host PATs (GitHub, GitLab) via OpenCode's keychain for private-repo indexing |

## Configuration

Plugin options (second element of the plugin tuple in `opencode.json`):

```jsonc
{
  "plugin": [
    ["opentrace-opencode", {
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

## Structure

```
src/
  index.ts                — Plugin entrypoint; registers tools + hooks
  graph-client.ts         — opentraceai CLI wrapper (spawn + JSON parse)
  auth.ts                 — Auth hook + token storage
  tools/                  — One file per tool, each exporting createXxxTool(client)
  hooks/                  — system-prompt, tool-augment, tool-impact, shell-env
  util/                   — db-discovery, debug, cli-install, node-id
package.json              — npm package manifest
tsconfig.json             — TS config (Bun types, ESM)
bun.lock                  — Dependency lockfile
```

## Dev Mode

To run against a local checkout of the agent CLI (when developing new CLI subcommands), set `OPENTRACE_CMD` before launching OpenCode:

```bash
OPENTRACE_CMD="uv run --directory /path/to/opentrace/agent opentraceai" opencode
```

The plugin will use that command instead of `uvx opentraceai`, so agent source changes are visible immediately without publishing.

## License

Apache License 2.0
