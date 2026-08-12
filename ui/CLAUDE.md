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
  appComponents/
    wiki/                     — Vault management UI (AddVaultModal, VaultManager,
                                wiki.css) — management only, no reader
  graph/                      — Graph data hooks (useGraphData, useGraphInstance)
  chat/                       — AI chat panel (tool-use against the graph)
  config/                     — Runtime feature flags
  gen/                        — Generated proto types (do not edit; regen via `make ts` in proto/)
```

### No vault reader

`appComponents/wiki/` is management-only. Vault **reading** happens on the graph
node: a `KnowledgeDoc`'s markitdown-normalised body renders as markdown in
`appComponents/NodeDetailsPanel.tsx`, the same way a `File` shows its source.

`chat/vaultTools.ts` exports one tool, `list_vaults`. `[[wiki-link]]` syntax is
not part of the product, so there is no dedicated wiki markdown renderer.

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

### "Communities" here ≠ the agent's "clusters"

`communityWorker` / `useCommunities` compute a Louvain partition **in the
browser, over whatever nodes are currently loaded**, for node colour and layout
grouping. It is view state: never persisted, recomputed (debounced) whenever the
node set changes, and scoped to what is on screen rather than to the whole graph.
This feature owns the name "communities" — keep it.

The agent has a separate, unrelated partition with its own name: `opentraceai
cluster` runs Leiden over the *entire indexed graph* and stores the result as a
`cluster` property on each node, feeding `analyze`, the exporters, and the MCP
tools. See `agent/src/opentrace_agent/store/CLAUDE.md`.

Nothing connects the two. The viewer does **not** read the stored property, so
its colours and the groupings `analyze` reports can disagree about the same
graph. Both are the same shape (node id → integer group id) and node
`properties` already reach the viewer, so preferring the stored partition when
present — with this worker as the fallback for browser-indexed and
not-yet-clustered graphs — is a small change if that divergence ever matters.
Beware the sampling caveat before doing it: the viewer loads a capped slice, so
a whole-graph partition can fragment into many tiny on-screen groups.

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
- **`components/` must not reach app singletons.** `tsconfig.lib.json` compiles `src/components` alone — no `src/store`, no `src/providers`, and deliberately without the `lbug-wasm.d.ts` ambient shim. A component that imports one of those drags the whole store layer into the pure-library declaration build and fails on the missing shim. That error is the boundary working; don't widen the config's `include` to silence it. UI wired to app context belongs in `appComponents/` (covered by `tsconfig.lib-app.json`), which is why the vault management UI lives there. `npm run build:lib` is the only check that catches this — `tsc -b` does not.
- **Parser init race.** `TreeSitter.Parser.init()` is global and async; calling it concurrently corrupts state. Use a singleton promise guard (`wasm.ts`).
- **Store immutability.** Don't try to hot-swap from server to in-memory mode — re-mount `StoreContext`.
- **SharedArrayBuffer fails silently** without COOP/COEP headers. If the dev server starts but WASM features break, check that `crossOriginIsolation()` plugin is enabled.
