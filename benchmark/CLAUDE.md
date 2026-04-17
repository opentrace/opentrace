# Benchmark

Accuracy validation and SWE-bench evaluation harness. Driven entirely via the `Makefile` here; actual benchmark logic lives in `agent/src/opentrace_agent/benchmarks/`.

## Quick Reference

```bash
make download          # Fetch SWE-bench Lite dataset (required before swe-bench targets)
make accuracy          # All 3 graph accuracy levels
make accuracy-1        # Level 1: single file, 8 tasks
make accuracy-2        # Level 2: multi-file, 16 tasks
make accuracy-3        # Level 3: polyglot, 26 tasks
make swe-bench-smoke   # 1 SWE-bench instance (sanity check)
make swe-bench-5       # 5 diverse instances
make swe-bench         # Full 300 instances
make compare           # A/B: with vs without OpenTrace
```

## Tuning Knobs

| Variable | Default | Description |
|---|---|---|
| `V=1` | off | Verbose — show per-task results and index stats |
| `WORKERS=N` | 1 | Parallel SWE-bench workers |
| `BACKEND` | `claude-code` | Agent backend (`claude-code` or `api`) |
| `MODEL` | `sonnet` | Model to use |

## Accuracy Levels

Accuracy benchmarks test graph extraction correctness against golden fixtures:

| Level | Fixture Dir | Scope |
|---|---|---|
| 1 | `tests/fixtures/level1` | Single-file extraction |
| 2 | `tests/fixtures/level2` | Multi-file with cross-file calls |
| 3 | `tests/fixtures/level3` | Polyglot (multiple languages in one project) |

Tasks (JSON) live in `agent/src/opentrace_agent/benchmarks/tasks/`. Fixtures live in `/tests/fixtures/`.

## Adding a Benchmark

1. Create a fixture codebase under `tests/fixtures/level{N}/` (or a new level)
2. Write a task JSON in `agent/src/opentrace_agent/benchmarks/tasks/`
3. Add a `make` target here, following the `accuracy-{1,2,3}` pattern

## Pitfalls

- **`make download` is required before any SWE-bench target.** Without it, the data file dependency fails silently (Makefile target not found).
- **`clean` preserves `data/`.** Only `clean-all` removes downloaded datasets. This is intentional — re-downloading 300 instances is slow.
- **All benchmarks invoke `uv run opentraceai-bench`** from the agent dir. The benchmark CLI is part of the agent package, not a standalone binary.
