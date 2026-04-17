# Pipeline

Four-stage generator pipeline that turns a discovered codebase into a saved knowledge graph. Built as a linear LangGraph `StateGraph`.

## Files

```
pipeline.py    — Public entrypoints: core_pipeline(), run_pipeline(), collect_pipeline()
types.py       — PipelineEvent, PipelineInput/Context/Result, Phase, EventKind, GraphNode/Relationship
scanning.py    — Stage 1: DirectoryWalker → Repository/Directory/File + CONTAINS edges
processing.py  — Stage 2: per-file extraction → Class/Function nodes + Registries
resolving.py   — Stage 3: 7-strategy call resolution → CALLS edges
saving.py      — Stage 4: stream events into Store (LadybugDB)
adapters.py    — Convert SymbolExtractor results into pipeline graph primitives
store.py       — Store protocol + LadybugDB-backed implementation
```

## Stage Contract

Each stage is an async generator:

```python
async def stage(ctx: PipelineContext, input: T_in, output: StageResult[T_out]) -> AsyncIterator[PipelineEvent]:
    yield PipelineEvent(kind=STAGE_START, ...)
    # do work, yielding PROGRESS events
    output.value = ...   # MUST set before STAGE_STOP
    yield PipelineEvent(kind=STAGE_STOP, ...)
```

`StageResult` is the cross-stage handoff: the next stage reads `prev_output.value`. Setting it after `STAGE_STOP` is a bug — downstream sees `None`.

## Call Resolution (Stage 3)

`resolving.py` applies seven strategies **in priority order**, stopping at the first match:

1. **self/this** — `self.foo()` resolved against the enclosing class's methods
2. **Go receiver** — `r.method()` matched via `_receiver_type` recorded by Go extractor
3. **`ClassName.method`** — explicit class-qualified call
4. **Imports** — alias map from `import_analyzer` resolves `fmt.Println` → external `pkg:*`
5. **Constructor** — `Foo()` matched against class definition (Python-style)
6. **Intra-file** — bare `foo()` matched against same-file functions
7. **Cross-file** — fall back to global `Registries` lookup by FQN

Strategies emit only "confident" matches; ambiguous calls are dropped silently. If you change priority order, run `tests/opentrace_agent/pipeline/test_resolving.py` end-to-end.

## Events

Consumers (CLI, UI via `serve.py`) iterate the generator to drive progress UI. Events are typed by `EventKind`:

- `STAGE_START` / `STAGE_STOP` — stage boundaries
- `PROGRESS` — per-unit-of-work updates (file scanned, symbol extracted)
- `LOG` — diagnostic messages
- `ERROR` — recoverable; pipeline continues

Use `collect_pipeline()` for tests (drains the generator, returns final `PipelineResult`). Use `run_pipeline()` for fire-and-forget. Use `core_pipeline()` when you need the raw event stream.

## Pitfalls

- **Cancellation is cooperative.** Stages check `ctx.cancelled` between units; an in-progress tree-sitter parse cannot be interrupted. Don't expect sub-second cancel latency on large files.
- **Registries are in-memory.** All extracted symbols persist for the duration of `resolving`; very large monorepos are the dominant memory pressure.
- **Cyclic class hierarchies can loop.** The receiver-type strategy walks up the superclass chain; malformed input (A → B → A) is not currently detected. Add a visited set if you touch this.
- **Saving is a wrapper, not a stage.** `saving.run_with_save()` consumes events from `core_pipeline` and side-effects into the store; tests using `collect_pipeline()` skip persistence on purpose.
