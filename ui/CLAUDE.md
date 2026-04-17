# UI

React/TypeScript frontend for OpenTrace — graph visualization, browser-based indexing, and chat. Built with Vite; renders graphs with Pixi.js v8 + d3-force.

## Layout

```
src/
  App.tsx / OpenTraceApp.tsx  — Top-level shell (settings, graph viewer, chat)
  store/                      — GraphStore abstraction (pluggable backend)
  job/                        — Browser job service (submits & streams indexing work)
  components/
    pixi/                     — WebGL graph renderer (Pixi.js + d3-force workers)
    pipeline/                 — Browser tree-sitter extraction pipeline
    indexing/                 — Repo-add UI (AddRepoModal, IndexingProgress)
    graph/                    — Graphology helpers, Louvain clustering, filtering
    workers/                  — Web Worker orchestration (layout, community)
  graph/                      — Graph data hooks (useGraphData, useGraphInstance)
  chat/                       — AI chat panel (tool-use against the graph)
  config/                     — Runtime feature flags
  gen/                        — Generated proto types (do not edit; regen via `make ts` in proto/)
```

## Two Operating Modes

The UI runs in one of two modes, chosen at startup:

| Mode | Store | Backend | Writes? | Use case |
|---|---|---|---|---|
| **Server** | `ServerGraphStore` | `opentrace serve` REST | Read-only (no-op `importBatch`) | CLI-indexed repo, production |
| **In-memory** | `LadybugStore` (WASM) | Browser-local LadybugDB | Full read/write | Browser-only indexing |

Mode is determined by whether a server URL is configured. The `StoreContext` React provider wraps the singleton store; swapping mode requires re-mounting the provider — there's no hot-swap.

## Build & Dev

```bash
npm install
npm run dev          # Vite dev server, default port 5173
PORT=5174 npm run dev  # alternate port (strictPort — fails if taken)
```

### Vite Config Quirks

- **`resolveEnvDir()`** — `.env` is gitignored; worktrees fall back to the main tree's `.env`
- **COOP/COEP headers** — `crossOriginIsolation()` plugin sets `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` so `SharedArrayBuffer` works (required by `lbug-wasm`)
- **WASM middleware** — force-sets `Content-Type: application/wasm` on `.wasm` responses (Vite default is wrong)
- **Worker format** — ES modules (`worker.format: 'es'`)
- **Aliases** — resolve to `src/components/` sources, not pre-built dist, so Vite processes workers

### Thread Model

Heavy computation runs off the main thread:

| Worker | Purpose |
|---|---|
| `pixiLayoutWorker` | Persistent d3-force simulation (streamed positions) |
| `communityWorker` | Louvain clustering |
| `d3LayoutWorker` | One-shot layout snapshot |

Workers use transferable objects (Float64Array) for zero-copy position handoff. **Copy the buffer before React state updates** — ownership transfers on `postMessage`.

## Key Interfaces

- `GraphStore` (`store/types.ts`) — the data-access contract. Add methods here, implement in both `serverStore.ts` and `ladybugStore.ts`, or make them optional with `?`.
- `JobService` (`job/types.ts`) — submits indexing work, returns `JobStream` (async-iterable events).
- `PipelineEvent` (`components/pipeline/types.ts`) — mirrors the agent's `PipelineEvent` shape; phases are `scanning → processing → resolving → summarizing → submitting`.

## Dependencies on `agent/`

- **Proto types** — `gen/` is generated from the same protobuf source as the agent
- **REST endpoints** — `ServerGraphStore` calls `opentrace serve` (see `agent/src/opentrace_agent/cli/CLAUDE.md`)
- **Extractors mirror** — the browser pipeline reimplements the same extraction logic in TS; cross-validation fixtures in `/tests/` ensure they agree

## Pitfalls

- **Pre-existing build errors.** `App.tsx` and `gen/` may have minor type issues that pre-date your changes — don't fix them unless they block your work.
- **Parser init race.** `TreeSitter.Parser.init()` is global and async; calling it concurrently corrupts state. Use a singleton promise guard (`wasm.ts`).
- **Store immutability.** Don't try to hot-swap from server to in-memory mode — re-mount `StoreContext`.
- **SharedArrayBuffer fails silently** without COOP/COEP headers. If the dev server starts but WASM features break, check that `crossOriginIsolation()` plugin is enabled.
