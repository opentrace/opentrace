# OpenTrace — Codex plugin

Knowledge graph tools for [Codex CLI](https://developers.openai.com/codex).
Wires Codex to the OpenTrace MCP server and exposes seven skills for common
codebase exploration workflows.

## What you get

**MCP tools** (via `uvx opentraceai mcp`):

*Discovery*
- `get_stats` — node/edge counts and breakdown by type
- `list_nodes` — enumerate all nodes of a given type

*Search*
- `keyword_search` — single keyword **or** multi-word natural-language
  query.  Tokenizes (drops stopwords + filler nouns like "function" /
  "code" / "handle"), searches per keyword, merges, ranks by match
  count.  Each result is tagged with `_match_field` so the caller
  knows whether a hit was on `name` (high-confidence) vs `docs`
  (docstring matched — body may be stale; carries a `_verify`
  instruction).
- `search_graph` — returns a **subgraph** (matched nodes + their
  neighbors + the relationships between them).  Use when the question
  is structural ("show me the area of the graph around X").

*Navigation*
- `get_node` — full node details and immediate neighbors
- `traverse_graph` — walk relationships outgoing/incoming/both
- `find_usages` — incoming CALLS / IMPORTS / DEPENDS_ON / EXTENDS / IMPLEMENTS
  edges of a symbol, capped at 5 hops

*Source access*
- `source_read` — read code from any indexed repo by node ID or
  repo-relative path; line slicing supported, no permission prompts
- `source_grep` — ripgrep across every indexed checkout, with repo and glob
  filters; returns repo-relative paths

*Analysis*
- `impact_analysis` — blast radius of edits to a file (optionally narrowed
  by line ranges)

*Indexing*
- `repo_index` — index a **local directory or remote git URL** into the
  running server's database and hot-reload. URLs are cloned to
  `~/.opentrace/repos/{org}/{name}/` so `source_read` can serve them
  later. Authentication for private repos is resolved silently — see
  *Authenticating to private repos* below.

**Skills** (invoked by the model when user intent matches):
- `opentrace-graph-status` — status overview of what's indexed
- `opentrace-explore` — explore a named component
- `opentrace-find-usages` — find callers/dependents of a symbol
- `opentrace-impact` — blast-radius analysis before editing a file
- `opentrace-index` — index a project into the graph
- `opentrace-interrogate` — answer a codebase question, read-only
- `opentrace-update` — check/install CLI updates

## Prerequisites

- [`uv`](https://docs.astral.sh/uv/) installed — the plugin calls
  `uvx opentraceai` under the hood.
- An indexed repo. Run the `opentrace-index` skill once, or from the terminal:
  ```bash
  cd /path/to/repo
  uvx opentraceai index .
  ```
  This creates `.opentrace/index.db` at the repo root, which the MCP server
  auto-discovers from any subdirectory.

## Install

See the parent [`../../README.md`](../../README.md) for the full install
walkthrough. Quick version:

```bash
# 1. Register the marketplace (from an OpenTrace checkout)
codex plugin marketplace add ./codex-plugin

# 2. Launch Codex and enable the plugin from the in-session UI
codex
> /plugins
# install opentrace from the opentrace-oss marketplace
```

Third-party marketplaces don't auto-enable their plugins; the `/plugins`
step is required.

## Indexing remote repositories

The MCP `repo_index` tool and the `opentraceai fetch-and-index` CLI both
clone a public git URL into `~/.opentrace/repos/{org}/{name}/` and run
the full indexer against the clone. Only public repositories are
supported in the open-source build — private repository support is part
of the paid OpenTrace product.

## AGENTS.md directive

Codex reads `AGENTS.md` at the start of every session. Adding the snippet
below to your repo's `AGENTS.md` is the single biggest lever for getting
Codex to actually use OpenTrace instead of defaulting to `rg` / `grep` /
`find` / `cat`. Pair it with the hooks shipped in
[`../../.codex/`](../../.codex/) for runtime nudges; `AGENTS.md` primes
the model from the first turn.

```markdown
## OpenTrace — tool routing

This repository is indexed into OpenTrace. The graph already knows every
class, function, file, service, endpoint, and the relationships between
them. **Default to OpenTrace tools BEFORE shell `rg` / `grep` / `find` /
`cat`** — the graph answers in one call what would take many shell
commands.

| Question shape | Use | Not |
|---|---|---|
| Find a symbol by name | `keyword_search` | `rg <name>` |
| Read a file by node ID or path | `source_read` | `cat <path>` |
| Search across indexed repos | `source_grep` | `rg` (only sees cwd) |
| Trace callers / dependents | `find_usages` or `traverse_graph` | manual rg + grep loops |
| Pre-edit blast radius | `impact_analysis` | nothing — rg can't do this |
| Structural overview | `get_stats` + `list_nodes` | `tree` / `find` / `wc -l` |
| Subgraph around a node | `search_graph` | not possible in shell |
| Add a new repo to the graph | `repo_index` | `git clone` + manual indexing |

Fall back to shell only when (a) OpenTrace returns no results, (b) the
file isn't in any indexed repo, or (c) the user explicitly asks for raw
shell output. After non-trivial edits, re-run `repo_index` (or the
`opentrace-index` skill) so the graph stays fresh.

Trust hint: `keyword_search` results carry a `_match_field` tag — treat
`name` / `signature` matches as authoritative, but for `_match_field:
"docs"` hits, follow up with `source_read` before quoting docstrings as
fact (docstrings drift from the code they describe).
```

## Limitations vs. Claude Code & OpenCode plugins

Codex's plugin model is intentionally narrow — only **skills (markdown)**,
**MCP servers (external)**, and **hooks (separate `~/.codex/` install)** are
extension points. We ship hooks separately via
[`../../install.sh`](../../install.sh) since Codex hook config lives in
`~/.codex/`, not inside a plugin bundle. After `./install.sh --home`,
session-start guidance, periodic graph briefings, and shell rg/grep
augmentation all work.

Remaining gaps versus the sibling OpenCode plugin (`opentrace-opencode/`):

- **PostToolUse hook on Edit/Write** — Codex's hook contract exposes
  PreToolUse on `Bash`, but no post-Edit / post-Write event we can
  attach blast-radius reports to. Run the `opentrace-impact` skill (or
  call `impact_analysis` directly) before editing files you're not sure
  about.
- **`shell.env` injection** — Codex shells don't auto-receive
  `OPENTRACE_DB`. Set it explicitly if you need it in scripts.
- **Private-repo indexing** — the open-source build only clones public
  URLs. Private-repo support (token storage, OAuth device flow,
  hostname-keyed credential resolution) is part of the paid OpenTrace
  product.

Sub-agents are absent in Codex; the skills above cover the same
workflows the OpenCode plugin's sub-agents would.