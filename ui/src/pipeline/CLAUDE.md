# Pipeline

Browser-based indexing pipeline that parses repository files into a knowledge graph of nodes and relationships.

## Architecture

The pipeline is a chain of synchronous generators. Each stage yields `PipelineEvent` objects containing graph nodes, relationships, and progress info. Two wrapper stages intercept the event stream to enrich nodes and persist them.

```
runPipeline()
  saving(inner, store)              ← persists nodes/rels to the store
    wrapWithSummaries(inner)        ← adds summary property to every node
      corePipeline()                ← produces events via:
        yield* scanning()           ← repo structure (files, dirs, packages)
        yield* processing()         ← symbol extraction (classes, functions)
        yield* resolving()          ← call resolution (CALLS relationships)
```

### Two patterns

- **Stages** (`scanning`, `processing`, `resolving`): delegating generators called with `yield*`. They accept typed input and return typed output.
- **Wrappers** (`wrapWithSummaries`, `saving`): pass-through generators that take an inner generator, intercept each event, and re-yield it. They never produce new events.

## Stages

### scanning.ts

Builds the structural graph from the repo file tree.

- **Input**: `LoadingInput` (repo tree with files)
- **Emits on `stage_stop`**: Repository, Directory, File, Package (from manifests) nodes + DEFINED_IN, DEPENDS_ON relationships
- **Returns**: `ScanResult` with node references and lookup maps (`knownPaths`, `pathToFileId`)

### processing.ts

Parses each file with tree-sitter extractors, builds symbol nodes, and analyzes imports.

- **Input**: `ScanResult`
- **Emits on `stage_progress`** (per file): Class, Function nodes + DEFINED_IN, IMPORTS relationships. May emit additional Package nodes discovered via import analysis.
- **Returns**: `ProcessingOutput` with registries for call resolution

### resolving.ts

Resolves function call references to target symbols using the registries from processing.

- **Input**: `ProcessingOutput`
- **Emits on `stage_progress`**: CALLS relationships only. No nodes.

### summarizing.ts (`wrapWithSummaries`)

Wraps the entire pipeline event stream. For every node that lacks a `summary` property, generates one using the template summarizer (identifier analysis, file patterns, directory patterns). Mutates nodes in-place on the events — does not emit new events or nodes.

### saving.ts

Wraps the summarized event stream. Calls `store.saveNode()` / `store.saveRelationship()` for every node and relationship on every event as it flows through.

## Node ID Conventions

| Node Type | ID Format | Example |
|-----------|-----------|---------|
| Repository | `owner/repo` | `opentrace/opentrace` |
| Directory | `owner/repo/path` | `opentrace/opentrace/src/utils` |
| File | `owner/repo/path/file` | `opentrace/opentrace/src/main.ts` |
| Class | `fileId::ClassName` | `opentrace/opentrace/src/main.ts::Handler` |
| Function | `fileId::funcName` | `opentrace/opentrace/src/main.ts::parse` |
| Method | `classId::methodName` | `opentrace/opentrace/src/main.ts::Handler::handle` |
| Package | `pkg:registry:name` | `pkg:npm:express` |

All IDs except Package are repo-prefixed and unique per repo. Package IDs are global and shared across repos.

## Event Flow

Each event has a `kind`, `phase`, and optionally `nodes`/`relationships`:

```
stage_start  scanning                     (no nodes)
stage_progress scanning  × N              (no nodes — progress ticks)
stage_stop   scanning                     (Repository, Directory[], File[], Package[])
stage_start  processing                   (no nodes)
stage_progress processing × M             (Class[], Function[], Package[]?)
stage_stop   processing                   (no nodes)
stage_start  resolving                    (no nodes)
stage_progress resolving                  (no nodes — CALLS rels only)
stage_stop   resolving                    (no nodes)
done                                      (PipelineResult)
```

Each node type is emitted by exactly one stage. No stage re-emits another stage's nodes.

## Key Conventions

- **`dirNodes` Map key**: bare path (e.g. `"src"`, `"src/utils"`), NOT the full node ID. The node's `.id` property has the full `repoId/path` form.
- **Store merging**: stores merge properties when a node with an existing ID arrives (`{ ...existing.properties, ...new.properties }`). This handles Package nodes that can arrive from both scanning (manifests) and processing (imports).
- **Cancellation**: checked between stages via `ctx.cancelled`. Mid-stage cancellation is not supported.

## Files

```
pipeline.ts              ← orchestrator: composes stages + wrappers
types.ts                 ← all type definitions (PipelineEvent, ScanResult, etc.)
stages/
  scanning.ts            ← repo structure → Repository, Directory, File, Package
  processing.ts          ← symbol extraction → Class, Function + import analysis
  resolving.ts           ← call resolution → CALLS relationships
  summarizing.ts         ← wrapper: adds summary to every node
  saving.ts              ← wrapper: persists to store
  loading.ts             ← helpers: ensureDirChain, parentDir, detectLanguage
  parsing.ts             ← helpers: initParsers, getExtractor, processSymbol
store/
  memory.ts              ← in-memory Store impl for tests (merges on saveNode)
__tests__/
  pipeline.test.ts       ← integration tests (requires tree-sitter WASM)
  cross-repo.test.ts     ← multi-repo dedup and isolation tests
  fixture.test.ts        ← extractor fixture tests
  parsing.test.ts        ← parsing unit tests
  loading.test.ts        ← loading helper tests
  helpers.ts             ← test utilities (makeRepoTree, getPythonParser)
```
