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
scripts/                    — Shell scripts used by hooks
```

## Versioning

Three files must stay in sync when bumping versions:

| File | Field |
|---|---|
| `.claude-plugin/plugin.json` | `version` |
| `../.claude-plugin/marketplace.json` | `plugins[0].version` |
| `../agent/pyproject.toml` | `version` (agent package, bump independently for agent-only changes) |

Plugin and marketplace versions must always match. Agent version is bumped independently but should be bumped alongside plugin changes that affect the CLI (e.g. new subcommands).

## Agents

| Agent | File | Purpose |
|---|---|---|
| `@opentrace` | `agents/opentrace.md` | **Default catch-all** — any codebase question |
| `@code-explorer` | `agents/code-explorer.md` | Code structure, files, directories, browsing |
| `@dependency-analyzer` | `agents/dependency-analyzer.md` | Blast radius and impact analysis |
| `@find-usages` | `agents/find-usages.md` | Caller/reference lookups |
| `@explain-service` | `agents/explain-service.md` | Top-down service walkthroughs |

## Writing Agent/Skill Descriptions

The `description` field in frontmatter is the **routing table** — Claude Code matches user intent against it. Guidelines:

- List concrete trigger phrases users actually say ("what's in X", "show me X", "find X")
- Include file/directory/browsing patterns, not just code-symbol patterns
- End with a broad catch-all ("any question about repo structure, code organization, files, or component relationships")
- Think about what queries would otherwise fall through to `ls`, `find`, or `Glob`

## MCP Tools

All agents/skills use these tools from the `opentrace-oss` MCP server:

| Tool | Use for |
|---|---|
| `get_stats` | Orient — see what node types and counts are indexed |
| `search_graph` | Find nodes by name, with optional `nodeTypes` filter |
| `list_nodes` | Enumerate all nodes of a type |
| `get_node` | Full node details + immediate neighbors |
| `traverse_graph` | Walk relationships (outgoing/incoming/both) with depth control |

## Session-Start Hook

`scripts/session-start.sh` runs at session init and:
1. Searches for `otindex.db` in `.`, `..`, `../../`
2. Runs `uvx opentraceai stats --db <path>` to get graph coverage (best-effort)
3. Injects `additionalContext` JSON telling Claude what's indexed and which agents to use

The stats call may fail if the MCP server already holds the DB lock — the hook falls back gracefully.
