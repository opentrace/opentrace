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

| Agent | File | Purpose |
|---|---|---|
| `@opentrace` | `agents/opentrace.md` | **Default catch-all** — any codebase question |
| `@code-explorer` | `agents/code-explorer.md` | Code structure, files, directories, browsing |
| `@dependency-analyzer` | `agents/dependency-analyzer.md` | Blast radius and impact analysis |
| `@find-usages` | `agents/find-usages.md` | Caller/reference lookups |
| `@explain-service` | `agents/explain-service.md` | Top-down service walkthroughs |

## Skills

Skill names match the Codex plugin so the routing language is consistent across both.

| Skill | Purpose |
|---|---|
| `opentrace-explore` | Named-component exploration (class, function, service) |
| `opentrace-find-usages` | Cross-repo caller/dependent enumeration |
| `opentrace-graph-status` | What's indexed — counts, repos, services |
| `opentrace-impact` | Pre-edit blast radius for a file or line range |
| `opentrace-index` | Index/re-index a path or remote git URL |
| `opentrace-interrogate` | Read-only "how does X work" investigation |
| `opentrace-update` | Update the `opentraceai` CLI |

## Writing Agent/Skill Descriptions

The `description` field in frontmatter is the **routing table** — Claude Code matches user intent against it. Guidelines:

- List concrete trigger phrases users actually say ("what's in X", "show me X", "find X")
- Include file/directory/browsing patterns, not just code-symbol patterns
- For skills designed to win against shell tools, lead with **PREFERRED** and explicitly contrast against `rg` / `grep` / `cat` / `find`
- End with a broad catch-all ("any question about repo structure, code organization, files, or component relationships")
- Think about what queries would otherwise fall through to `ls`, `find`, or `Glob`

## MCP Tools

All agents, skills, and commands use these tools from the `opentrace-oss` MCP server (eleven total):

| Tool | Use for |
|---|---|
| `keyword_search` | Tokenized name + signature + docs search; results carry `_match_field` |
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

The plugin ships four hooks. All Python scripts live in `scripts/` and import from `scripts/_common.py` (event I/O, workspace discovery, CLI runner, shell parsing).

| Event | Script | Behavior |
|---|---|---|
| `SessionStart` | `session_start.py` | Inject the table-style routing directive + current `stats`. If no `.opentrace/index.db` exists, kick off `uvx opentraceai index <repo>` in the background. Best-effort PyPI version-compare emits an upgrade notice when applicable. |
| `UserPromptSubmit` | `user_prompt_submit.py` | Once every 10 min (per UID, TTL cached in `$TMPDIR`), re-inject the routing reminder + fresh `stats` so long sessions don't drift back to shell tools. |
| `PreToolUse` (Grep / Glob / Bash) | `pre_tool_use.py` | Augment shell `rg`/`grep`/`ack`/`ag` with `opentraceai augment` results. Augment shell `cat`/`head`/`tail`/`sed`/`awk` on code files with `opentraceai impact`. |
| `PostToolUse` (Edit / Write) | `post_tool_use.py` | After a successful edit, run `opentraceai impact` (with line-range hint when available) and inject the result as `additionalContext`. |

All hooks fail closed: any error returns silently and lets Claude Code proceed normally. Set `OPENTRACE_DEBUG=1` to write timestamped traces to `.opentrace/hook-debug.log` (override path with `OPENTRACE_DEBUG_LOG=...`).

The PreToolUse and PostToolUse hooks are **complementary**:
- PreToolUse fires before Claude Code runs the tool, and only for shell commands and Grep/Glob (i.e. when Claude was about to bypass the graph).
- PostToolUse fires after Edit/Write completes, so the impact analysis reflects the actual changed file content.
