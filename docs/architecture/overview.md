# Architecture Overview

OpenTrace builds a single knowledge graph that holds three layers of information about your project. Code structure comes from tree-sitter; doc labels and entities come from LLM extraction over documents whose bodies stay verbatim. Nothing is synthesized — no layer is written in the model's own prose. Edges connect them.

## Component layout

```
┌──────────────────────────────────────────────────────┐
│                    UI (React/TS)                     │
│   Graph explorer · Knowledge highlights · Chat       │
│   localhost:5173        ┌─────────────────────────┐  │
│                         │  Tree-sitter WASM worker│  │
│                         │  LadybugDB WASM store   │  │
│                         └─────────────────────────┘  │
└──────────────────────────────────────────────────────┘
                            │ REST / MCP
                            ▼
┌──────────────────────────────────────────────────────┐
│                  Agent (Python CLI)                  │
│   index · vault · cluster · analyze · serve · mcp    │
│                                                      │
│  ┌────────────────┐  ┌────────────────────────────┐  │
│  │  Pipeline      │  │   Retrieval primitives     │  │
│  │  scan→process→ │  │   search / overview /      │  │
│  │   extract→     │  │   find_path / provenance / │  │
│  │   resolve→save │  │   communities / mentions / │  │
│  │  + autoprune   │  │   cross_domain_bridges     │  │
│  └────────────────┘  └────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  LadybugDB store (.opentrace/index.db)         │  │
│  │  + corpus bodies (.opentrace/corpus/<sha>.md)  │  │
│  │  + vaults (~/.opentrace/vaults/<name>/ or      │  │
│  │            <project>/.opentrace/vaults/<name>/)│  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## The three layers

The graph holds three layers, each populated by different stages:

### 1. Code (structural)

Tree-sitter walks source files and emits `Repository` / `Directory` / `File` / `Class` / `Function` / `Variable` nodes plus `DEFINES` / `CALLS` / `IMPORTS` / `DEPENDS_ON` edges. Always produced — no LLM cost, no opt-in.

### 2. Entity (semantic, flat)

Opt-in via `index --wiki`. The per-doc ingestion call extracts named entities from ingested doc bodies:

| Type | Examples |
|---|---|
| `Idea` | "Authentication", "Diffusion Models", "Rate Limiting" |
| `Service` | "auth-service", "billing-api" |
| `Module` | "TokenBucket", "AuthMiddleware" |
| `Paper` | "Attention Is All You Need" |
| `Person` | "Karen Chen", "Vaswani et al." |
| `Event` | "the 2024 release" |

Edges: `DERIVED_FROM` (entity → KnowledgeDoc) carries the entity's provenance. `SEMANTIC_EDGE` (entity → entity) is an LLM-proposed relationship with discrete confidence (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`). Entities derive from KnowledgeDocs; if code-derived entities are ever introduced, they anchor to File nodes, and MIRRORS keeps the two worlds joined.

### 3. Page (the indexed documents)

Opt-in via `index --wiki`. The doc-ingestion pipeline produces:

- `KnowledgeVault` — one per vault (scope: `local` or `global`)
- Labelled `KnowledgeDoc` nodes — each ingested doc gets a navigation label (`title` + `one_line_summary`) and an epistemic `status` (`authoritative` / `design_history` / `design_history_archived`); the raw body stays verbatim in the corpus and is read via `load_source`

Edges: `CONTAINS` (vault → page/doc), `LINKS_TO` (KnowledgeDoc → KnowledgeDoc, parsed mechanically from the relative links the docs' authors wrote to each other — the doc-side analogue of the code layer's import edges), `MENTIONS` (KnowledgeDoc or page → entity whose name appears in the doc's corpus markdown or the page body — connects layer 3 to layer 2), `MIRRORS` (KnowledgeDoc → File, for every doc indexed from a directory — the File node is created at link time when the code walk skipped its extension — joins the corpus layer to the code tree in one hop), `DOCUMENTS` (Repository → Vault, for vaults spawned by `index --wiki` over that repo — attached globals and dropped-file vaults never get it).

There is no synthesis half. `KnowledgeConcept(kind="concept")` nodes — multi-source narratives with bodies on disk, plus `CITES` (concept page → KnowledgeDoc) and page ↔ page `LINKS_TO` from `[[Title]]` wiki-links — were produced by an opt-in `--wiki-concept-pages` flag until 2026-08-03. It was removed: a synthesized page restates its sources in the model's own voice, which drops their hedges, tense, and attribution, and it measured 88.4% against a 98.6% control on the doc-Q&A benchmark. Cross-document questions are answered by corpus `grep` instead — verbatim lines from every doc, pre-labelled with title and status.

The node and edge types remain valid so a vault compiled before the removal keeps its pages: they stay on disk (canonical), stay mirrored into the graph, and `vault attach` still rebuilds that mirror.

See [Ontology](ontology.md) for the full node + edge reference.

## Domains and cross-cutting structure

The three layers form three **domains** in the cross-cutting analysis:

```
code domain     — Repository / Directory / File / Class / Function / Variable
entity domain   — Idea / Service / Module / Paper / Person / Event
page domain     — Vault / Page / KnowledgeDoc
```

`opentraceai analyze` surfaces:

- **Cross-community bridges** — edges spanning detected communities
- **Cross-domain bridges** — edges spanning code ↔ entity ↔ page (the original "AuthMiddleware appears in 5 code files plus 2 design docs" view)
- **Cross-cutting communities** — communities whose members span ≥2 domains

The `MENTIONS` edge is the explicit bridge between the entity and page domains, deduped against `DERIVED_FROM` so the two never restate the same doc↔entity pair — MENTIONS carries references, `DERIVED_FROM` carries origin. `MIRRORS` is the direct code ↔ page bridge — a `KnowledgeDoc` and its `File` twin reach each other in one hop.

## Components

### UI (`ui/`)

React/TypeScript frontend, runs in the browser. Includes:

- **Graph Explorer** — visual graph navigation, BM25 + vector + RRF search
- **Tree-sitter WASM worker** — browser-side parsing for in-app indexing
- **LadybugDB WASM** — embedded graph store for browser-only mode
- **Chat Agent** — in-app AI that uses graph tools + vault tools to ground answers
- **Knowledge Highlights panel** — surfaces god nodes / bridges / suggested questions

Two operating modes selected at startup: **Server** mode talks to `opentraceai serve`; **In-memory** mode uses LadybugDB WASM directly for browser-local indexing.

### Agent (`agent/`)

Python package + CLI (`opentraceai`). Managed with [uv](https://docs.astral.sh/uv/). One command (`index`) handles all ingestion; the rest of the CLI is querying and graph management.

| Command | Purpose |
|---|---|
| `index` | Build/refresh the graph from code, docs, or both. See [Indexing](../getting-started/indexing.md) |
| `vault` | Ingest a bare doc folder, and manage compiled vaults — ingest, list, show, attach, detach, promote, demote |
| `cluster` / `analyze` | Community detection + cross-cutting analysis |
| `export-graph` | Deterministic projections — graphml, obsidian, report |
| `watch` / `hook` | Filesystem watcher + git post-commit hook for incremental re-indexes |
| `serve` | REST API for the UI |
| `mcp` | MCP stdio server for agent clients |

### Protobuf (`proto/`)

Shared schema for code-graph types (regenerated into Python + TypeScript). Source of truth for `RepositoryNode` / `FileNode` / `KnowledgeVaultNode` / etc. — see `proto/opentrace/v1/code_graph.proto`.

### Plugins

- `plugins/claude-code/` — MCP server config + slash commands + a `graph` skill. Auto-discovers the agent's MCP tools.
- `plugins/opencode/` — native TypeScript plugin running in OpenCode's Bun runtime; calls the CLI directly.

## Data flow

A typical full-stack run (`index ./repo myvault --wiki`):

```
1. Scan      → DirectoryWalker walks the path, classifying each file
               as code (tree-sitter target) or doc (markitdown target).
               Emits Repository / Directory / File nodes.

2. Process   → Per-file tree-sitter extraction → Class / Function /
               Variable nodes + intra-file Registries.

3. Ingest    → For each doc:
               • markitdown converts to markdown
               • Body persisted to .opentrace/corpus/<sha>.md
               • KnowledgeDoc node created (corpus::<sha>); when the
                 doc also produced a File node in the code walk, a
                 MIRRORS edge joins the twins and the repo-relative
                 path is stamped on the KnowledgeDoc

4. Resolve   → Cross-file call resolution → CALLS edges.

5. Save      → All emitted nodes/edges land in the LadybugDB store.

6. Index     → run_compile makes one DocExtraction LLM call per doc
   docs        (KnowledgeDoc navigation label + entity graph with
               DERIVED_FROM edges — and nothing else), then writes
               the graph mirror with CONTAINS / MENTIONS edges, the
               authors' own doc→doc LINKS_TO edges, and the epistemic
               status stamps. Bodies stay verbatim in the corpus.
               This is the only LLM stage; nothing is synthesized.

7. Autoprune → Compare walked doc set against the existing graph;
               delete orphan KnowledgeDocs + the entities anchored to
               them; for legacy vaults that still have pages, remove
               dangling CITES edges from concept pages, delete pages
               left with zero citations, stamp stale_since on the rest.
```

`opentraceai cluster` and `opentraceai analyze` are separate steps that read the assembled graph and write Community / Hyperedge nodes (cluster) or just print analysis (analyze).

## Storage layout

```
.opentrace/                           # graph + corpus + local vaults
  index.db                            # LadybugDB graph store
  index.db.wal                        # write-ahead log
  corpus/<sha>.md                     # raw doc bodies, sha-keyed
  vaults/<name>/                      # local vaults (scope=local)
    pages/concept/<base>.md           # legacy concept pages — vaults
                                      #  compiled before 2026-08-03 only
    .vault.json
    .compile-log/<ts>.json

~/.opentrace/vaults/<name>/           # global vaults (scope=global)
  pages/concept/<base>.md             # legacy only, as above
  .vault.json
  .compile-log/<ts>.json
```

Disk is canonical for doc bodies (and legacy page bodies). The graph holds metadata + relationships + a denormalised reference to corpus paths. `vault attach` rebuilds a graph mirror from disk in seconds (no LLM).

## Conventions

- **Read-only retrieval.** Every primitive under `opentrace_agent.retrieval` is read-only. Writes go through `index` / `vault attach` / `cluster`.
- **Vault scope is a property.** `vault` denormalised onto every page / doc / entity so scope queries are property equality, not graph traversal.
- **Discrete confidence.** All confidence values snap to a discrete rubric (`EXTRACTED` = 1.0, `INFERRED` ∈ {0.55, 0.65, 0.75, 0.85, 0.95}, `AMBIGUOUS` ∈ [0.1, 0.3]) — never 0.5.
- **No backward-compat shims.** Each command does one thing; renamed commands are gone, not aliased.
