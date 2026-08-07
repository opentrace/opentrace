# Agent

Python package `opentrace_agent` — the indexing and serving CLI (`opentraceai`) that walks a codebase, extracts symbols and relationships into a knowledge graph, and exposes that graph via REST and MCP.

## Layout

```
src/opentrace_agent/
  cli/         — Click commands: index, serve, mcp, vault, augment, auth, …
  sources/     — Source discovery + per-language symbol extraction (tree-sitter)
                 plus markdown/ doc plumbing (fetch, markitdown, corpus store)
  pipeline/    — Four-stage pipeline (scan → process → resolve → save) as LangGraph
  retrieval/   — Read-only agent-facing query primitives (search, overview,
                 paths, counts, provenance, grep, communities)
  wiki/        — Doc-ingestion pipeline + vault metadata (`index --wiki`,
                 `vault ingest`)
  store/       — LadybugDB persistence (Cypher queries, schema)
  summarizer/  — Pluggable code summarization (Flan-T5)
  benchmarks/  — SWE-bench harness and accuracy benchmark CLI
                 (`opentraceai-bench`)
  gen/         — Generated graph schema (do not edit; regenerate via `make graph` in proto/)
tests/         — Mirrors src layout; fixture-based extractor + pipeline tests
```

## Tooling

- **Package manager:** `uv` (lock at `uv.lock`, sync with `uv sync`)
- **Build backend:** `hatchling`
- **CLI entrypoint:** `opentraceai = opentrace_agent.cli.main:app` in `pyproject.toml` (`opentrace` is an alias; `opentraceai-bench` is separate)
- **Tests:** `uv run pytest`; async tests use `pytest-anyio` with `@pytest.mark.anyio`
- **Format/lint:** invoke via `make fmt` / `make lint` from repo root

## Configuration

`opentrace_agent.cli.config` uses `pydantic-settings` with the `OT_` env prefix. Fields are typed; missing required env triggers a startup error rather than runtime `KeyError`.

## Database Discovery

Every CLI subcommand calls `cli.main.find_db()`, which walks up from cwd looking for `.opentrace/index.db`, stopping at the git root. Override with `--db <path>`. Discovery rejects symlinks that escape the repo and caps traversal depth — touch with care, this is a security boundary.

## Pipeline at a Glance

The graph build is a generator-based four-stage chain in `pipeline/`:

1. **scanning** — `DirectoryWalker` emits `Repository`/`Directory`/`File` nodes
2. **processing** — Per-file tree-sitter extraction → `Class`/`Function` nodes + per-file `Registries`
3. **resolving** — 7-strategy call resolution → `CALLS` relationships
4. **saving** — Persist events to `Store` (LadybugDB)

Each stage yields `PipelineEvent` objects. Cancellation is **cooperative** (`ctx.cancelled` is checked between units of work, never mid-parse). See `pipeline/CLAUDE.md` for details.

## Conventions

- **Node subclasses** must define `graph_type` and `save_function_name` ClassVars; `relationship_mapping` dict maps `RelationType` → MCP function names.
- **Tree-sitter ASTs are expensive.** Never re-parse — pass `root_node` through `ExtractionResult` and reuse it. (Past O(n²) regression.)
- **Pre-compute shared sets/dicts** (e.g. `known_paths`) once outside per-file loops, not per file.
- **Generated code lives in `gen/`** and must not be hand-edited. Source of truth is `proto/`.

## Cross-Cutting Pitfalls

- `MagicMock` cannot intercept `__getattr__` — when mocking the MCP client or store, use a small custom class.
- External-package nodes use synthetic IDs of the form `pkg:registry:name` and are version-agnostic — multiple versions collapse into one node.
- Large repos can OOM during `processing` because all `Registries` are held in memory before `resolving` consumes them.
