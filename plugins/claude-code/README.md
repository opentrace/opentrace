# OpenTrace Claude Code Plugin

[Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that exposes the OpenTrace knowledge graph for codebase exploration. Ships twelve MCP tools, eleven skills, three subagents, four slash commands, and eight hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, SubagentStop, Notification).

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

## Configuration

The plugin works out of the box with no configuration — the defaults below favor predictable, low token usage, so everything optional is **off** unless you opt in. Set these as environment variables before launching Claude Code (e.g. `OPENTRACE_CLAUDE_AUTO_CONTEXT=1 claude`).

| Env var | Default | Effect |
|---------|---------|--------|
| `OPENTRACE_CLAUDE_AUTO_CONTEXT` | off | When `=1`, the `PreToolUse` hook augments Grep/Glob with graph results, and `PostToolUse` injects `impact_analysis` after each Edit/Write. Off by default so prompts stay token-cheap; the normal path is explicit MCP tool calls plus the SessionStart routing directive. Turn it on if you want the graph to proactively surface context as you search and edit. |
| `OPENTRACE_CLAUDE_AUGMENT_BASH` | off | When `=1`, also augments shell search/read commands (`rg`/`grep`/`cat`/`head`/…) run via Bash. **Requires `OPENTRACE_CLAUDE_AUTO_CONTEXT=1`** — it widens auto-context to the Bash tool, it doesn't enable auto-context on its own. |
| `OPENTRACE_DEBUG` | off | When `=1`, every hook writes timestamped traces to `.opentrace/hook-debug.log` (and stderr). See [Debug Mode](#debug-mode). |
| `OPENTRACE_DEBUG_LOG` | `.opentrace/hook-debug.log` | Override the debug log path. |
| `OPENTRACE_INDEX_TIMEOUT` | `1800` | Wall-clock budget in **seconds** for `repo_index` / background indexing subprocesses. `0` (or negative) means no timeout. Applies to the MCP server process. |

> **Why auto-context is opt-in:** injecting graph payloads on every search/edit can flood the context window in a long session. The plugin defaults to pull-based — Claude calls the MCP tools when it needs them — and only pushes context when you explicitly enable it. The staleness-tracking side of `PostToolUse` always runs; it's free at edit time and only speaks up when the graph is actually stale.

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
| `opentrace-diagram` | Generate a Mermaid diagram of a service / module / class from the subgraph |
| `opentrace-dead-code` | List Function / Class nodes with zero incoming CALLS/IMPORTS edges |
| `opentrace-refactor-plan` | Produce a structured rename/refactor plan with every call site and snippet |
| `opentrace-onboarding-tour` | Top-down tour of a service for a new contributor — entry points, central functions |

## Agents

| Agent | Description |
|-------|-------------|
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes |
| `@find-usages` | Find all callers, references, and usages of a component |
| `@explain-service` | Top-down walkthrough of how a service or module works |

> `@opentrace` and `@code-explorer` were removed in 0.8.0. For general
> codebase questions, describe what you want and Claude will route to the
> `opentrace-explore` / `opentrace-interrogate` skills automatically.

## Commands

| Command | Description |
|---------|-------------|
| `/auth` | Set up a git personal access token so OpenTrace can clone and index private repositories |
| `/graph-status` | Show overview of indexed nodes by type, list repos and services |
| `/index` | Index (or re-index) the current project into the knowledge graph |
| `/update` | Check for and install updates to the `opentraceai` CLI |

> `/explore` and `/interrogate` were removed in 0.8.0 — they duplicated the
> `opentrace-explore` / `opentrace-interrogate` skills.

## MCP Tools

All agents, skills, and commands use these tools from the `opentrace-oss` MCP server (backed by `uvx opentraceai mcp`):

| Tool | Description |
|------|-------------|
| `keyword_search` | Tokenized name + signature + docs search; ranks by keyword coverage; returns `_match_field`-tagged results |
| `fts_search` | Whole-phrase full-text search (BM25 + Porter stemmer) over `search_text`; ranks by relevance score; optional `repo` / `nodeTypes` filters |
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

The plugin ships eight hooks that Claude Code runs automatically:

| Event | Script | Purpose |
|-------|--------|---------|
| `SessionStart` | `scripts/session_start.py` | Inject the routing directive + current graph stats; kick off background indexing if no DB exists |
| `UserPromptSubmit` | `scripts/user_prompt_submit.py` | If any files have been edited since the last index, emit a one-shot staleness warning (throttled to 10 min) |
| `PreToolUse` (Grep / Glob / Bash) | `scripts/pre_tool_use.py` | Opt-in auto context: augment shell `rg`/`grep` with graph results, and shell `cat`/`head`/`tail`/`sed`/`awk` with impact analysis |
| `PostToolUse` (Edit / Write) | `scripts/post_tool_use.py` | Record the edited file path + mtime to `staleness.json`; opt-in auto context: run `impact_analysis` on the changed file |
| `Stop` | `scripts/stop.py` | At session end, summarize stale files and suggest `/index`; prune `staleness.json` entries older than 7 days |
| `PreCompact` | `scripts/pre_compact.py` | Re-inject the routing directive + current `get_stats` so post-compact context still knows how to route |
| `SubagentStop` | `scripts/subagent_stop.py` | Warn if a delegated OpenTrace subagent finished without using any graph tool |
| `Notification` | `scripts/notification.py` | When awaiting input AND a background index has completed since last fire, announce "index updated" (best-effort — only fires when a notification event occurs) |

All hooks share `scripts/_common.py` (event I/O, workspace discovery, CLI runner, shell parsing, TTL caches) and `scripts/_debug.py` (opt-in debug logging). They fail closed — any error returns silently and lets Claude Code proceed normally. To minimize token usage, `PreToolUse` and `PostToolUse` do not inject graph payloads unless `OPENTRACE_CLAUDE_AUTO_CONTEXT=1` is set before launching Claude Code. Bash augmentation also requires `OPENTRACE_CLAUDE_AUGMENT_BASH=1`. The staleness-tracking side of `PostToolUse` runs unconditionally — it costs nothing at edit time and only emits context on the next user prompt when the graph is actually stale.

## Structure

```
.claude-plugin/plugin.json  — Plugin manifest (name, version, description)
.mcp.json                   — MCP server config (stdio, runs opentraceai CLI)
agents/                     — Subagent definitions (.md with YAML frontmatter)
skills/                     — Skill definitions (directories with SKILL.md)
commands/                   — Slash command definitions (.md)
hooks/hooks.json            — Hook event bindings
statusline.sh               — Opt-in status line (graph freshness + node count)
scripts/                    — Hook scripts:
  _common.py                  shared utilities (event I/O, TTL caches, staleness, directive builder)
  _debug.py                   opt-in debug logging
  session_start.py            SessionStart hook
  user_prompt_submit.py       UserPromptSubmit hook (staleness warning, throttled)
  pre_tool_use.py             PreToolUse hook (Grep/Glob/Bash augmentation)
  post_tool_use.py            PostToolUse hook (records edits + opt-in impact analysis)
  stop.py                     Stop hook (session-end staleness summary)
  pre_compact.py              PreCompact hook (re-inject directive after compaction)
  subagent_stop.py            SubagentStop hook (warn on graph-less subagent runs)
  notification.py             Notification hook (announce index completion)
```

## How It Works

1. **Session start** auto-discovers `.opentrace/index.db` by walking up from cwd. If found, it injects the tool-routing directive plus current graph stats. If not found, it kicks off `uvx opentraceai index <repo>` in the background and tells the user to wait a moment.
2. **MCP server** (`uvx opentraceai mcp`) starts over stdio and exposes the twelve graph query tools.
3. **PreToolUse** is pull-based by default for token economy. Set `OPENTRACE_CLAUDE_AUTO_CONTEXT=1` to enable inline graph augmentation for Grep/Glob; also set `OPENTRACE_CLAUDE_AUGMENT_BASH=1` to include Bash search/read commands. See [Configuration](#configuration).
4. **UserPromptSubmit** checks whether any tracked edits postdate the index and, if so, emits a one-shot graph-staleness warning (throttled to once per 10 minutes); it stays silent when nothing is stale.
5. **PostToolUse** is also opt-in via `OPENTRACE_CLAUDE_AUTO_CONTEXT=1`; when enabled, injected context is capped and duplicate targets are suppressed for 5 minutes.

## Status Line (opt-in)

The plugin ships `statusline.sh`, a small fragment that reports the
freshness and size of the local graph. Wire it into your Claude Code
status line via `settings.json`:

```jsonc
{
  "statusLine": {
    "command": "${CLAUDE_PLUGIN_ROOT}/plugins/opentrace-oss/statusline.sh"
  }
}
```

Sample output:

```
otrc: idx 2h ago | 12.4k nodes
otrc: idx ⚠ stale (3) | 12.4k nodes   # 3 files edited since last index
otrc: no index
```

The script reads `.opentrace/index.db` mtime and the per-workspace
`staleness.json` cache the hooks maintain; it fails silent on any error
so it can't break your status line.

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
