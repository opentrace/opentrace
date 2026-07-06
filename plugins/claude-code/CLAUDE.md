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
| `../../.claude-plugin/marketplace.json` | `plugins[0].version` |
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
| `@graph-guide` | `agents/graph-guide.md` | Interactive guide over the knowledge graph |

## Skills

| Skill | File | Purpose |
|---|---|---|
| `explore-code` | `skills/explore-code/SKILL.md` | General codebase exploration via OpenTrace MCP |
| `graph` | `skills/graph/SKILL.md` | Router for knowledge-graph commands (build, query, explain, export) |

## Slash Commands

OpenTrace-native:

| Command | Purpose |
|---|---|
| `/index` | Index the current project into OpenTrace |
| `/update` | Update the `opentraceai` CLI |
| `/graph-status` | Overview of indexed nodes by type |
| `/explore <name>` | Quick exploration of a named component |
| `/interrogate <q>` | Read-only Q&A over the OpenTrace graph |

Knowledge-graph pipeline (all native — no external indexer dependency):

| Command | Purpose |
|---|---|
| `/build [path or url]` | Full pipeline — `opentraceai index` → `cluster` → `analyze` |
| `/add <url>` | Ingest a URL/document (PDF, Word, EPub, HTML, image, audio, video) via `opentraceai ingest` |
| `/path A B` | Shortest path between two graph nodes, walked hop-by-hop |
| `/cluster` | Re-run community detection (Leiden / Louvain) on the existing graph |
| `/analyze` | God nodes, cross-community bridges, starter questions |
| `/benchmark` | LLM extraction eval — precision/recall + confidence calibration |
| `/export-obsidian` | Obsidian vault (one file per node, wikilinks for edges) |
| `/export-wiki` | Markdown report folder — index dashboard with Mermaid map, per-community and per-god-node pages, bridges page |
| `/export-graphml` | GraphML for Gephi / yEd / Cytoscape |
| `/watch` | Watch a folder and re-index on changes |
| `/hook install\|uninstall\|status` | Post-commit git hook for incremental rebuilds |

Cross-corpus merge is folded into `opentraceai import`. MCP serving is the
existing `opentraceai mcp` — no separate `/mcp-server`.

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
| `load_source` | Read a node's underlying content — code from the repo checkout (with line ranges), `CorpusDoc` bodies from the corpus snapshot, `WikiPage` bodies from the vault |
| `read_vault_page` | Read a concept page's markdown body by node id |
| `find_pages_mentioning` | Entity/symbol → the WikiPages and CorpusDocs that discuss it (typed hits) |
| `provenance` | Trust chain — concept page → cited `CorpusDoc` artefacts (+ MIRRORS File twin when present); code → commit + line range |

## Database Convention

The index database lives at `.opentrace/index.db` in the repo root. All CLI commands (`index`, `mcp`, `stats`) auto-discover it by walking up from cwd, stopping at the git root. You can override with `--db <path>`.

Security: discovery rejects symlinks that resolve outside the git repo boundary, and caps traversal at 10 levels.

## Session-Start Hook

`scripts/session-start.sh` runs at session init and:
1. Walks up from cwd looking for `.opentrace/index.db` (same logic as CLI)
2. Runs `uvx opentraceai stats` to get graph coverage (best-effort, auto-discovers DB)
3. Injects `additionalContext` JSON telling Claude what's indexed and which agents to use

The stats call may fail if the MCP server already holds the DB lock — the hook falls back gracefully.
