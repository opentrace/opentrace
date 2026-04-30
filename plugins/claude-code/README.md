# OpenTrace Claude Code Plugin

[Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that exposes the OpenTrace knowledge graph for codebase exploration. Ships eleven MCP tools, seven skills, five subagents, five slash commands, and four hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse).

## Install

```bash
# From the repo root:
claude plugin marketplace add ./
claude plugin install opentrace-oss@opentrace-oss
```

Or reload after changes:

```bash
make plugin-reload    # from the repo root
```

## What It Does

Once installed, Claude Code gains access to your indexed codebase through graph query tools. Index a repo first (`uvx opentraceai index .` or use `/index` in Claude Code), then ask questions about code structure, dependencies, and architecture. The database is auto-discovered at `.opentrace/index.db` — no path configuration needed.

The hooks keep Claude Code routed to OpenTrace tools instead of drifting back to shell `rg`/`grep`/`cat` mid-session — see [Hooks](#hooks) below.

## Skills

| Skill | Description |
|-------|-------------|
| `opentrace-explore` | Explore a named component (class / function / service / file) via the graph |
| `opentrace-find-usages` | Find every caller, importer, or dependent of a symbol across all indexed repos |
| `opentrace-graph-status` | Report what's indexed — node counts, repos, services |
| `opentrace-impact` | Pre-edit blast-radius analysis for a file (or line range) |
| `opentrace-index` | Index (or re-index) a project — local path or remote git URL |
| `opentrace-interrogate` | Read-only investigation of "how does X work" questions |
| `opentrace-update` | Check for and install updates to the `opentraceai` CLI |

## Agents

| Agent | Description |
|-------|-------------|
| `@opentrace` | Default catch-all — any codebase question routed to the knowledge graph |
| `@code-explorer` | Explore code structure — find classes, functions, files, and their relationships |
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes |
| `@find-usages` | Find all callers, references, and usages of a component |
| `@explain-service` | Top-down walkthrough of how a service or module works |

## Commands

| Command | Description |
|---------|-------------|
| `/graph-status` | Show overview of indexed nodes by type, list repos and services |
| `/explore <name>` | Quick exploration of a named component in the graph |
| `/index` | Index (or re-index) the current project into the knowledge graph |
| `/interrogate` | Answer a question about the codebase without making changes |
| `/update` | Check for and install updates to the `opentraceai` CLI |

## MCP Tools

All agents, skills, and commands use these tools from the `opentrace-oss` MCP server (backed by `uvx opentraceai mcp`):

| Tool | Description |
|------|-------------|
| `keyword_search` | Tokenized name + signature + docs search; returns `_match_field`-tagged results |
| `search_graph` | Subgraph search — matched nodes plus their immediate neighbors and edges |
| `list_nodes` | List nodes of a specific type, with optional property filters |
| `get_node` | Full details of a single node by ID, including immediate neighbors |
| `traverse_graph` | BFS traversal with direction (incoming / outgoing / both) and relationship filters |
| `get_stats` | Total nodes / edges and breakdown by type |
| `find_usages` | All callers / importers / dependents of a symbol via CALLS / IMPORTS / DEPENDS_ON edges |
| `impact_analysis` | Pre-edit blast radius — symbols defined in a file plus their dependents |
| `source_read` | Read source by node ID or repo-relative path from any indexed repo |
| `source_grep` | Regex / literal search across all indexed repo checkouts |
| `repo_index` | Index a local path or clone-and-index a remote git URL; hot-reloads the server |

## Hooks

The plugin ships four hooks that Claude Code runs automatically:

| Event | Script | Purpose |
|-------|--------|---------|
| `SessionStart` | `scripts/session_start.py` | Inject the routing directive + current graph stats; kick off background indexing if no DB exists |
| `UserPromptSubmit` | `scripts/user_prompt_submit.py` | Re-inject a brief reminder every 10 min so the model doesn't drift back to shell tools |
| `PreToolUse` (Grep / Glob / Bash) | `scripts/pre_tool_use.py` | Augment shell `rg`/`grep` with `keyword_search` results, and shell `cat`/`head`/`tail`/`sed`/`awk` with `impact_analysis` |
| `PostToolUse` (Edit / Write) | `scripts/post_tool_use.py` | Run `impact_analysis` on the changed file and surface affected dependents |

All hooks share `scripts/_common.py` (event I/O, workspace discovery, CLI runner, shell parsing) and `scripts/_debug.py` (opt-in debug logging). They fail closed — any error returns silently and lets Claude Code proceed normally.

## Structure

```
.claude-plugin/plugin.json  — Plugin manifest (name, version, description)
.mcp.json                   — MCP server config (stdio, runs opentraceai CLI)
agents/                     — Subagent definitions (.md with YAML frontmatter)
skills/                     — Skill definitions (directories with SKILL.md)
commands/                   — Slash command definitions (.md)
hooks/hooks.json            — Hook event bindings
scripts/                    — Hook scripts:
  _common.py                  shared utilities
  _debug.py                   opt-in debug logging
  session_start.py            SessionStart hook
  user_prompt_submit.py       UserPromptSubmit hook (10-min TTL reminder)
  pre_tool_use.py             PreToolUse hook (Grep/Glob/Bash augmentation)
  post_tool_use.py            PostToolUse hook (Edit/Write impact analysis)
```

## How It Works

1. **Session start** auto-discovers `.opentrace/index.db` by walking up from cwd. If found, it injects the tool-routing directive plus current graph stats. If not found, it kicks off `uvx opentraceai index <repo>` in the background and tells the user to wait a moment.
2. **MCP server** (`uvx opentraceai mcp`) starts over stdio and exposes the eleven graph query tools.
3. **PreToolUse** augments shell search/read commands inline — when you run `rg foo` the hook runs `opentraceai augment foo` and prepends graph context to the tool output. Same for `cat path/to/file.py` → `opentraceai impact path/to/file.py`.
4. **UserPromptSubmit** re-injects a short routing reminder + current graph stats every 10 minutes so long sessions don't drift back to shell tools.
5. **PostToolUse** runs `opentraceai impact` on every file edited via Edit/Write so Claude Code immediately sees who depends on the change.

## Debug Mode

Set `OPENTRACE_DEBUG=1` before launching Claude Code to enable verbose hook logging:

```bash
OPENTRACE_DEBUG=1 claude
```

When enabled:
- All hook scripts write timestamped trace lines to `.opentrace/hook-debug.log` (auto-discovered next to `index.db`).
- The session-start `systemMessage` shows `| debug: <path>` so you can confirm it's active.
- Lines also go to stderr for real-time `tail -f` if the process is visible.

Override the log path with `OPENTRACE_DEBUG_LOG=/path/to/file.log`. The log file is gitignored via the root `*.log` pattern.

## Dev Mode

To run against a local checkout of the agent (e.g. when developing new MCP tools), override the MCP config to use `uv run` from the agent source directory:

```jsonc
// .mcp.json (dev override)
{
  "mcpServers": {
    "opentrace-oss": {
      "type": "stdio",
      "command": "uv",
      "args": [
        "run",
        "--directory", "/path/to/opentrace/agent",
        "opentraceai", "mcp"
      ],
      "description": "OpenTrace knowledge graph tools (dev)."
    }
  }
}
```

This uses the local agent source instead of the published PyPI package, so changes to `agent/` are reflected immediately without publishing.

## License

Apache License 2.0
