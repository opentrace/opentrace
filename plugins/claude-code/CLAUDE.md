# OpenTrace Claude Code Plugin

Claude Code plugin that exposes the OpenTrace knowledge graph for codebase exploration.

## Structure

```
.claude-plugin/plugin.json  — Plugin manifest (name, version, description)
.mcp.json                   — MCP server config (stdio, runs opentraceai CLI)
agents/                     — Subagent definitions (.md with YAML frontmatter)
skills/                     — Skill definitions (directories with SKILL.md)
commands/                   — Slash command definitions (.md)
hooks/hooks.json            — Hook event bindings
scripts/                    — Python hook scripts (snake_case; share _common.py)
```

## Versioning

Three files must stay in sync when bumping versions:

| File | Field |
|---|---|
| `.claude-plugin/plugin.json` | `version` |
| `../.claude-plugin/marketplace.json` | `plugins[0].version` |
| `../../agent/pyproject.toml` | `version` (agent package, bump independently for agent-only changes) |

Plugin and marketplace versions must always match. Agent version is bumped independently but should be bumped alongside plugin changes that affect the CLI (e.g. new subcommands).

## Agents

Skills are the primary lane for routing. Subagents are reserved for heavier multi-step delegations that benefit from a fresh context window.

| Agent | File | Purpose |
|---|---|---|
| `@dependency-analyzer` | `agents/dependency-analyzer.md` | Blast radius and impact analysis |
| `@find-usages` | `agents/find-usages.md` | Caller/reference lookups |
| `@explain-service` | `agents/explain-service.md` | Top-down service walkthroughs |

> Removed in 0.8.0: `@opentrace` (clone of `@code-explorer`) and `@code-explorer` itself. Their use cases are covered by the `opentrace-explore` / `opentrace-interrogate` skills, which route faster and don't burn a fresh subagent context.

## Skills

| Skill | Purpose |
|---|---|
| `opentrace-explore` | Named-component exploration (class, function, service) |
| `opentrace-find-usages` | Cross-repo caller/dependent enumeration |
| `opentrace-graph-status` | What's indexed — counts, repos, services |
| `opentrace-impact` | Pre-edit blast radius for a file or line range |
| `opentrace-index` | Index/re-index a path or remote git URL |
| `opentrace-interrogate` | Read-only "how does X work" investigation |
| `opentrace-update` | Update the `opentraceai` CLI |
| `opentrace-diagram` | Generate a Mermaid diagram from a subgraph |
| `opentrace-dead-code` | Surface Function / Class nodes with zero incoming edges |
| `opentrace-refactor-plan` | Structured rename/refactor plan with call sites + snippets |
| `opentrace-onboarding-tour` | Top-down tour of a service for a new contributor |

## Writing Agent/Skill Descriptions

The `description` field in frontmatter is the **routing table** — Claude Code matches user intent against it. Guidelines:

- List concrete trigger phrases users actually say ("what's in X", "show me X", "find X")
- Include file/directory/browsing patterns, not just code-symbol patterns
- For skills designed to win against shell tools, lead with **PREFERRED** and explicitly contrast against `rg` / `grep` / `cat` / `find`
- End with a broad catch-all ("any question about repo structure, code organization, files, or component relationships")
- Think about what queries would otherwise fall through to `ls`, `find`, or `Glob`

## MCP Tools

All agents, skills, and commands use these tools from the `opentrace-oss` MCP server (twelve total):

| Tool | Use for |
|---|---|
| `keyword_search` | Tokenized name + signature + docs search; ranks by keyword coverage; results carry `_match_field` |
| `fts_search` | Whole-phrase FTS (BM25 + Porter stemmer) over `search_text`; ranks by relevance score; optional `repo` / `nodeTypes` filters |
| `search_graph` | Subgraph search — matched nodes plus immediate neighbors and edges |
| `list_nodes` | Enumerate nodes of a specific type, with optional property filters |
| `get_node` | Full node details + immediate neighbors |
| `traverse_graph` | Walk relationships (outgoing/incoming/both) with depth control |
| `get_stats` | Orient — see what node types and counts are indexed |
| `find_usages` | All callers/importers/dependents via CALLS / IMPORTS / DEPENDS_ON edges |
| `impact_analysis` | Pre-edit blast radius — symbols defined in a file plus dependents |
| `source_read` | Read source by node ID or repo-relative path from any indexed repo |
| `source_grep` | Regex / literal search across all indexed repo checkouts |
| `repo_index` | Index a path or clone-and-index a remote git URL; hot-reloads the server |

## Database Convention

The index database lives at `.opentrace/index.db` in the repo root. All CLI commands (`index`, `mcp`, `stats`) auto-discover it by walking up from cwd, stopping at the git root. You can override with `--db <path>`.

Security: discovery rejects symlinks that resolve outside the git repo boundary, and caps traversal at 10 levels.

## Hooks

The plugin ships eight hooks. All Python scripts live in `scripts/` and import from `scripts/_common.py` (event I/O, workspace discovery, CLI runner, shell parsing, TTL caches, staleness tracker, directive builder).

| Event | Script | Behavior |
|---|---|---|
| `SessionStart` | `session_start.py` | Inject the table-style routing directive + current `stats`. If no `.opentrace/index.db` exists, kick off `uvx opentraceai index <repo>` in the background and write a `last_index.json` sentinel. Best-effort PyPI version-compare emits an upgrade notice. |
| `UserPromptSubmit` | `user_prompt_submit.py` | If any tracked edited path has `mtime > index.db mtime`, emit a one-shot staleness warning. Throttled to one warning per 10 min via `briefing_due()`. If nothing is stale, emits nothing. |
| `PreToolUse` (Grep / Glob / Bash) | `pre_tool_use.py` | Opt-in auto context. With `OPENTRACE_CLAUDE_AUTO_CONTEXT=1`, augment Grep/Glob with `opentraceai augment`; Bash also requires `OPENTRACE_CLAUDE_AUGMENT_BASH=1`. |
| `PostToolUse` (Edit / Write) | `post_tool_use.py` | Always records the edited file path + current mtime to `staleness.json`. Opt-in auto context: with `OPENTRACE_CLAUDE_AUTO_CONTEXT=1`, also runs `opentraceai impact` and injects capped, deduped impact context. |
| `Stop` | `stop.py` | Session-end staleness summary if any tracked edits postdate the index. Prunes `staleness.json` entries older than 7 days. |
| `PreCompact` | `pre_compact.py` | Re-injects the routing directive + current `get_stats` as `additionalContext` so the post-compact window still knows how to route. Uses `build_directive()` from `_common.py`. |
| `SubagentStop` | `subagent_stop.py` | Matches `agent_type` (namespace-stripped) against the plugin's three subagents, resolves the subagent's own transcript via `agent_id` (`<dir>/<session>/subagents/agent-<id>.jsonl` — the event's `transcript_path` is the parent's), and warns if it finished without calling any `mcp__opentrace_oss__*` tool. |
| `Notification` | `notification.py` | When awaiting input AND `.opentrace/index.db` mtime is newer than the cached `last_index.json` sentinel, announces "OpenTrace index updated" once. Best-effort: only fires when a Notification event occurs (permission prompt, idle). |

All hooks fail closed: any error returns silently and lets Claude Code proceed normally. Token-heavy auto context is off by default; the normal path is SessionStart guidance plus explicit MCP graph tools. The staleness side of `PostToolUse` runs unconditionally — it costs nothing at edit time and only emits context on the next user prompt when the graph is actually stale. Set `OPENTRACE_DEBUG=1` to write timestamped traces to `.opentrace/hook-debug.log` (override path with `OPENTRACE_DEBUG_LOG=...`).

The PreToolUse and PostToolUse hooks are **complementary**:
- PreToolUse can fire before Claude Code runs the tool, and only for shell commands and Grep/Glob (i.e. when Claude was about to bypass the graph), but only when auto context is enabled.
- PostToolUse can fire after Edit/Write completes, so the impact analysis reflects the actual changed file content, but only when auto context is enabled.

### State files (per-UID, in `$TMPDIR/opentrace-claude-hooks-{UID}/`)

| File | TTL | Owner | Purpose |
|---|---|---|---|
| `briefing.json` | 600s | `user_prompt_submit.py` | Throttles staleness warnings to once per 10 min. |
| `context.json` | 300s / 600s cleanup | `pre_tool_use.py`, `post_tool_use.py` | Dedupes injected context blocks. |
| `staleness.json` | 7 days | `post_tool_use.py` (writer), `user_prompt_submit.py` / `stop.py` / `statusline.sh` (readers) | Tracks edited file paths + mtimes for graph-staleness detection. |
| `last_index.json` | until next index | `session_start.py` (writer), `notification.py` (reader) | Sentinel for "index completed since last notification". |
