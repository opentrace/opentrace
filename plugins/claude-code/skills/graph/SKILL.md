---
name: graph
description: |
  Run the full OpenTrace knowledge-graph pipeline over a folder or repo — index,
  community detection, highlight surfacing, and the markdown / graphml / Obsidian
  exporters. Use this skill when the user wants more than the bare structural
  index: when they ask for communities, highlights, or a navigable artifact to
  hand to another tool.

  Triggers on:
  - "build the knowledge graph", "make a graph of this folder", "graph this"
  - "what is this codebase about", "give me a map of this project", "what's connected
    to what"
  - "find the communities", "cluster the graph", "what are the architectural hubs?"
  - any time a user mentions community detection, god nodes, or bridges
  - when `.opentrace/index.db` is already present in the working directory,
    an indexed graph exists — prefer answering from it over re-deriving
    answers from raw files
allowed-tools: Bash, Read, Write, Agent, mcp__opentrace_oss__search_graph, mcp__opentrace_oss__get_node, mcp__opentrace_oss__traverse_graph, mcp__opentrace_oss__list_nodes, mcp__opentrace_oss__get_stats
---

The user wants to build, refresh, or explore the OpenTrace knowledge graph.
This skill is the on-ramp — point at the right slash command and run it.

## Request
$ARGUMENTS

## Routing

Match the user's intent to one of the commands below. When in doubt, default to
`/build` for build / refresh and `/interrogate` for question-answering.

| Intent | Command |
|---|---|
| Build the graph from scratch on a folder or GitHub URL | `/build [path or url]` |
| Index only (no clustering / analysis) | `/index [path]` |
| Re-run community detection | `/cluster` |
| Surface god nodes, bridges, suggested questions | `/analyze` |
| Quick exploration of a named component | `/explore <name>` |
| Read-only Q&A over the graph | `/interrogate "<question>"` |
| Shortest path between two graph nodes | `/path <A> <B>` |
| Ingest a URL (webpage / PDF / arXiv / image / etc.) | `/add <url>` |
| Obsidian vault export | `/export-obsidian` |
| Browsable markdown wiki | `/export-wiki` |
| GraphML for Gephi / yEd | `/export-graphml` |
| Auto-rebuild on file changes | `/watch` |
| git post-commit hook for incremental rebuilds | `/hook install` |
| LLM extraction precision/recall benchmark | `/benchmark` |
| Counts of indexed nodes by type | `/graph-status` |

If the user asked a question the graph could answer directly (e.g. "what's
connected to AuthMiddleware?") and `.opentrace/index.db` exists, run
`/interrogate` yourself rather than asking the user which command to use.

## When the graph does not exist yet

If `.opentrace/index.db` is missing and the user is asking a graph-flavoured
question, offer to run `/build` first, then answer against the freshly built
graph.

## Conventions

- Edge confidence is one of EXTRACTED / INFERRED / AMBIGUOUS — when surfacing
  edges, propagate the tier so callers know what was directly observed vs.
  guessed.
- After any build, the OpenTrace MCP tools (`search_graph`, `get_node`,
  `traverse_graph`, `list_nodes`, `get_stats`) read the same `.opentrace/index.db`
  the slash commands wrote to. There is one graph, not two.
