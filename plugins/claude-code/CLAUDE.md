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
| `/path A B` | Shortest path between two graph nodes, walked hop-by-hop |
| `/cluster` | Re-run community detection (Leiden / Louvain) on the existing graph |
| `/analyze` | God nodes, cross-community bridges, starter questions |
| `/export-obsidian` | Obsidian vault (one file per node, wikilinks for edges) |
| `/export-graphml` | GraphML for Gephi / yEd / Cytoscape |
| `/export-report` | Folder of linked markdown pages (`index.md`, communities, god nodes, bridges) |

Cross-corpus merge is folded into `opentraceai import`. MCP serving is the
existing `opentraceai mcp` — no separate `/mcp-server`.

**Nothing validates a command file's invocation.** A `.md` here that shells out
to a CLI command the agent doesn't provide fails at the first `Bash` call, with
no error until a user runs it. Check `opentraceai --help` (and the relevant
`--help` for a subcommand group) before adding or editing one.

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
| `overview` | Session-start orientation in <500 tokens — counts + top concepts + recently-updated. Cheaper than `get_stats` + several `list_nodes` calls |
| `search_graph` | Find nodes by name, with optional `nodeTypes` filter |
| `list_nodes` | Enumerate all nodes of a type. `paged=True` returns `hasMore` — a `false` there is the completeness signal that makes "there is no X" safe to assert |
| `get_node` | Full node details + immediate neighbors |
| `traverse_graph` | Walk relationships (outgoing/incoming/both) with depth control |
| `find_path` | Shortest path between two nodes — "how are these two connected?" |
| `find_orphans` | Nodes of a type with no edges of a given type — "functions never called" |
| `find_via_relationship_to_type` | All `(A) -[edge]-> (B)` pairs for given types — "every File that DEFINES a Class" |
| `count_by` | Counts, globally or scoped to a parent — answer "how many" without enumerating |
| `load_source` | Read a node's underlying content — code from the repo checkout (with line ranges), `KnowledgeDoc` bodies verbatim from the corpus snapshot |
| `list_vaults` | Enumerate the `KnowledgeVault` nodes in this graph (name, scope, `last_compiled_at`, summary) |
| `grep` | Regex sweep over a repo checkout or a vault's whole document corpus — the exhaustive counterpart to ranked `search_graph`. Use it for "which documents discuss X"; there is no doc→topic edge to traverse |
| `provenance` | Trust chain — a `KnowledgeDoc`'s own identity (sha256, filename, path, ingest time, + MIRRORS File twin when present); code → commit + line range |
| `get_god_nodes` | Top-degree hubs — "what's connected to everything?". Degree-based, so it works on any indexed graph |
| `get_communities` | Detected clusters with cohesion + member counts |
| `get_bridges` | Edges spanning two different communities — where clusters touch |
| `find_cross_cutting_communities` | Communities whose members span ≥`min_domains` domains (code / doc) |

The last three need `opentraceai cluster` to have been run — they return an
empty list on an unclustered graph rather than erroring, so an empty result
means "not clustered yet" at least as often as it means "none exist". Check
`get_stats` for `Community` nodes before reading anything into it.
`find_cross_cutting_communities` additionally needs both domains present: on a
code-only graph (no vault ingested) nothing can span two domains, so it is
always empty there.

A vault is a **document index**, not a set of synthesized pages: `grep` for
exhaustive contact with every document, `load_source` for a verbatim body. Do
not describe pages in an agent or skill description — an advertised tool is a
capability the agent will spend calls on, so a description that promises one
the server doesn't serve costs real calls.

## Database Convention

The index database lives at `.opentrace/index.db` in the repo root. All CLI commands (`index`, `mcp`, `stats`) auto-discover it by walking up from cwd, stopping at the git root. You can override with `--db <path>`.

Security: discovery rejects symlinks that resolve outside the git repo boundary, and caps traversal at 10 levels.

## Session-Start Hook

`scripts/session-start.sh` runs at session init and:
1. Walks up from cwd looking for `.opentrace/index.db` (same logic as CLI)
2. Runs `uvx opentraceai stats` to get graph coverage (best-effort, auto-discovers DB)
3. Injects `additionalContext` JSON telling Claude what's indexed and which agents to use

The stats call may fail if the MCP server already holds the DB lock — the hook falls back gracefully.
