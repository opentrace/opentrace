# Pipeline

Browser-based code extraction pipeline — the TypeScript equivalent of the Python agent's `pipeline/`. Parses files with web-tree-sitter (WASM), extracts symbols, resolves calls, summarizes, and stores.

## Layout

```
pipeline.ts        — Orchestrator: runPipeline(), collectPipeline()
types.ts           — PipelineEvent, PipelinePhase, PipelineResult (mirrors agent's types)
wasm.ts            — Tree-sitter WASM loader (singleton guard)
parser/
  extractors/      — Per-language extractors (python.ts, typescript.ts, go.ts, generic.ts)
  callResolver.ts  — 7-strategy call resolution (same priorities as agent)
  importAnalyzer.ts — Import mapping per-language (alias → file ID)
concurrent/
  scheduler.ts     — Multi-stage work-queue: FileCacheStage → ExtractStage → ResolveStage → SummarizeStage → StoreStage → EmbedStage
stages/            — Individual stage implementations
store/
  memory.ts        — In-memory graph accumulator (collects nodes/relationships before batch flush)
summarizer/        — Template-based code summarization
__tests__/         — Extractor and pipeline tests
```

## Relationship to `agent/`

This pipeline is a **parallel reimplementation**, not a port. It shares:
- The same 7-strategy call resolution priorities
- The same node type names (`Class`, `Function`, `File`, etc.)
- Cross-validation against the same fixtures (`/tests/fixtures/`)

It does NOT share code. Changes to extraction logic must be made in both places and validated via cross-validation tests.

## WASM Concerns

- **`web-tree-sitter`** gives a module namespace; use `TreeSitter.Parser`, `TreeSitter.Language`, etc.
- **`Parser.init()` is global.** Concurrent calls corrupt state. `wasm.ts` wraps it in a singleton promise.
- **`parser.parse()` returns `Tree | null`.** Must null-check before `.rootNode`.
- **Lazy loading.** WASM grammars are loaded on first use from `/public/wasm/`. The `ParserMap` scans repo files and loads only needed grammars.
- **SharedArrayBuffer required.** WASM streaming needs COOP/COEP headers (set by Vite config). Without them, parsing silently fails in some browsers.

### Supported Languages

12 parseable languages via bespoke (Python, TypeScript, Go) + generic extractor:

| Bespoke | Generic |
|---|---|
| Python, TypeScript/TSX, Go | JavaScript, Rust, Java, Kotlin, Ruby, C, C++, C#, Swift |

To add a generic language: extend the config table in `parser/extractors/generic.ts`. Needs a `tree-sitter-<lang>.wasm` in `/public/wasm/` — build with `npx tree-sitter build --wasm`.

**Exception:** YAML's grammar has a C++ external scanner incompatible with WASM. It was attempted and removed.

## Pipeline Phases

`scanning → processing → resolving → summarizing → submitting`

Each phase emits `PipelineEvent` objects (matching proto `JobPhase`). The concurrent scheduler processes these as work queues — multiple files progress through different stages in parallel. Cancellation is cooperative (checked between files, not mid-parse).

## Pitfalls

- **Grammar packages need `--legacy-peer-deps`** due to optional `tree-sitter` native peer dep. This only matters at install time, not runtime.
- **Kotlin AST differences.** `simple_identifier` not `identifier`. Rust uses `function_signature_item` for trait methods.
- **Two extractors, one truth.** When fixing an extraction bug, check if the same bug exists in the Python extractor (and vice versa). The cross-validation tests in `/tests/` will catch divergence, but only for the fixture cases.
- **Template summarizer is the default.** LLM summarization is opt-in; the template path must work offline with no API keys.
