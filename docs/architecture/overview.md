# Architecture Overview

OpenTrace builds a single knowledge graph that holds three layers of information about your project. Code structure comes from tree-sitter; doc content comes from LLM extraction; curated narratives come from a Plan + Execute pipeline. Edges connect them.

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

Opt-in via `index --extract-entities`. An LLM extracts named entities from both code and doc bodies:

| Type | Examples |
|---|---|
| `Idea` | "Authentication", "Diffusion Models", "Rate Limiting" |
| `Service` | "auth-service", "billing-api" |
| `Module` | "TokenBucket", "AuthMiddleware" |
| `Paper` | "Attention Is All You Need" |
| `Person` | "Karen Chen", "Vaswani et al." |
| `Event` | "the 2024 release" |

Edges: `DERIVED_FROM` (entity → source File / Source) carries the entity's provenance. `SEMANTIC_EDGE` (entity → entity) is an LLM-proposed relationship with discrete confidence (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`).

### 3. Page (curated)

Opt-in via `index --build-pages`. The wiki Plan + Execute pipeline produces:

- `WikiVault` — one per vault (scope: `local` or `global`)
- `WikiPage(kind="file_summary")` — one per Source, body on disk
- `WikiPage(kind="concept")` — multi-source curated narrative

Edges: `CONTAINS` (vault → page/source), `CITES` (concept → summary → Source), `LINKS_TO` (`[[Title]]` syntax in bodies), `MENTIONS` (page → entity whose name appears in the body — connects layer 3 to layer 2).

The page layer is the closest thing OpenTrace has to a "human-readable wiki." Pages live on disk and are mirrored into the graph; disk is canonical and `vault attach` rebuilds the mirror.

See [Ontology](ontology.md) for the full node + edge reference.

## Domains and cross-cutting structure

The three layers form three **domains** in the cross-cutting analysis:

```
code domain     — Repository / Directory / File / Class / Function / Variable
entity domain   — Idea / Service / Module / Paper / Person / Event
page domain     — WikiVault / WikiPage / Source
```

`opentraceai analyze` surfaces:

- **Cross-community bridges** — edges spanning detected communities
- **Cross-domain bridges** — edges spanning code ↔ entity ↔ page (the original "AuthMiddleware appears in 5 code files plus 2 design docs" view)
- **Cross-cutting communities** — communities whose members span ≥2 domains

The `MENTIONS` edge is the explicit bridge between the entity and page domains. `DERIVED_FROM` bridges entity ↔ code or entity ↔ page. The code and page domains rarely connect directly — they meet through the entity layer.

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
| `vault` | Manage compiled vaults — list, show, attach, detach, promote, demote, refresh-stale-pages |
| `cluster` / `analyze` | Community detection + cross-cutting analysis |
| `export-graph` | Deterministic projections — graphml, obsidian, report |
| `watch` / `hook` | Filesystem watcher + git post-commit hook for incremental re-indexes |
| `serve` | REST API for the UI |
| `mcp` | MCP stdio server for agent clients |

### Protobuf (`proto/`)

Shared schema for code-graph types (regenerated into Python + TypeScript). Source of truth for `RepositoryNode` / `FileNode` / `WikiVaultNode` / etc. — see `proto/opentrace/v1/code_graph.proto`.

### Plugins

- `plugins/claude-code/` — MCP server config + slash commands + a `graph` skill. Auto-discovers the agent's MCP tools.
- `plugins/opencode/` — native TypeScript plugin running in OpenCode's Bun runtime; calls the CLI directly.

## Data flow

A typical full-stack run (`index --extract-entities --build-pages ./repo myvault`):

```
1. Scan      → DirectoryWalker walks the path, classifying each file
               as code (tree-sitter target) or doc (markitdown target).
               Emits Repository / Directory / File nodes.

2. Process   → Per-file tree-sitter extraction → Class / Function /
               Variable nodes + intra-file Registries.

3. Extract   → For each Source (doc) + each code File body:
               • markitdown converts to markdown (docs only)
               • Body persisted to .opentrace/corpus/<sha>.md
               • LLM extracts entities → Idea / Service / ... nodes
                 with DERIVED_FROM edges

4. Resolve   → Cross-file call resolution → CALLS edges.

5. Save      → All emitted nodes/edges land in the LadybugDB store.

6. Build     → run_compile reads doc Sources, runs Plan + Execute,
   pages       writes WikiPage bodies to disk + graph mirror with
               CONTAINS / CITES / LINKS_TO + MENTIONS edges.

7. Autoprune → Compare walked source set against the existing graph;
               delete orphan Sources / entities / file_summary pages;
               stamp stale_since on concept pages losing a citation.
```

`opentraceai cluster` and `opentraceai analyze` are separate steps that read the assembled graph and write Community / Hyperedge nodes (cluster) or just print analysis (analyze).

## Storage layout

```
.opentrace/                           # graph + corpus + local vaults
  index.db                            # LadybugDB graph store
  index.db.wal                        # write-ahead log
  corpus/<sha>.md                     # raw doc bodies, sha-keyed
  vaults/<name>/                      # local vaults (scope=local)
    pages/concept/<base>.md           # multi-source synthesis pages
    pages/file-summary/<base>.md    # one-per-uploaded-file summary pages
    .vault.json
    .compile-log/<ts>.json

~/.opentrace/vaults/<name>/           # global vaults (scope=global)
  pages/concept/<base>.md
  pages/file-summary/<base>.md
  .vault.json
  .compile-log/<ts>.json
```

Disk is canonical for page bodies + source bodies. The graph holds metadata + relationships + a denormalised reference to corpus paths. `vault attach` rebuilds a graph mirror from disk in seconds (no LLM).

## Conventions

- **Read-only retrieval.** Every primitive under `opentrace_agent.retrieval` is read-only. Writes go through `index` / `vault attach` / `cluster`.
- **Vault scope is a property.** `vault` denormalised onto every page / source / entity so scope queries are property equality, not graph traversal.
- **Discrete confidence.** All confidence values snap to a discrete rubric (`EXTRACTED` = 1.0, `INFERRED` ∈ {0.55, 0.65, 0.75, 0.85, 0.95}, `AMBIGUOUS` ∈ [0.1, 0.3]) — never 0.5.
- **No backward-compat shims.** Each command does one thing; renamed commands are gone, not aliased.
