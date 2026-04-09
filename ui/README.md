# @opentrace/opentrace

React components for interactive graph visualization, in-browser code indexing, and AI-powered code analysis — built with Pixi.js, Graphology, and tree-sitter WASM.

## Install

```bash
npm install @opentrace/opentrace
```

## Quick Start

### Full App

Drop in the complete OpenTrace experience with a single component:

```tsx
import { OpenTraceApp } from '@opentrace/opentrace/app';
import '@opentrace/opentrace/style.css';

function App() {
  return <OpenTraceApp />;
}
```

### Graph Canvas Only

Use the graph renderer as a standalone component:

```tsx
import { GraphCanvas, useGraphInstance } from '@opentrace/opentrace';
import '@opentrace/opentrace/style.css';

function MyGraph() {
  const { graph, stats } = useGraphInstance();
  return <GraphCanvas />;
}
```

## Exports

The package provides multiple entry points for tree-shaking:

| Entry Point                        | Contents                                                     |
| ---------------------------------- | ------------------------------------------------------------ |
| `@opentrace/opentrace`             | Graph canvas, hooks, filters, layout, color utilities        |
| `@opentrace/opentrace/store`       | Graph store (LadybugDB WASM-backed) and context providers    |
| `@opentrace/opentrace/pipeline`    | Code extraction pipeline — parsers, call resolver, summarizer |
| `@opentrace/opentrace/pipeline/wasm` | WASM loader utilities for tree-sitter parsers              |
| `@opentrace/opentrace/indexing`    | Repository indexing UI (AddRepoModal, IndexingProgress)      |
| `@opentrace/opentrace/chat`       | LLM chat components and message rendering                    |
| `@opentrace/opentrace/job`        | Job execution and streaming for async indexing operations     |
| `@opentrace/opentrace/app-components` | Full app panels (GraphViewer, NodeDetailsPanel, ChatPanel) |
| `@opentrace/opentrace/app`        | Drop-in `OpenTraceApp` component with all providers          |
| `@opentrace/opentrace/utils`      | Shared utility functions                                     |

## WASM Setup

The indexing pipeline uses tree-sitter WASM grammars for in-browser code parsing. Copy the required WASM files to your app's public directory:

```bash
npx opentrace-copy-wasm public/wasm

# Or pick specific languages:
npx opentrace-copy-wasm --languages python,typescript,go public/wasm

# Runtime WASM only (no language grammars):
npx opentrace-copy-wasm --runtime-only public/wasm
```

Supported languages: Python, TypeScript, TSX, Go, Rust, Java, Kotlin, Ruby, C, C++, C#, Swift, Bash, JSON, TOML.

## Development

```bash
make install   # npm install
make dev       # Start Vite dev server
make build     # Production build (app)
make test      # Run tests
make fmt       # Format with Prettier
make lint      # ESLint + Prettier check
```

### Library Build

```bash
npm run build:lib    # Build the component library (dist/lib/)
npm run build:wasm   # Rebuild tree-sitter WASM grammars
```

### Worktree & Port Handling

When running from a git worktree, `vite.config.ts` automatically resolves `.env` from the main working tree. Set a custom port to avoid collisions:

```bash
PORT=5174 npm run dev
```

## Architecture

```
src/
├── components/       # Reusable component library (published)
│   ├── graph/        #   Pixi.js graph canvas & rendering
│   ├── pixi/         #   Low-level Pixi.js primitives
│   ├── pipeline/     #   Code extraction pipeline (tree-sitter)
│   ├── indexing/     #   Repo indexing UI
│   ├── chat/         #   Chat message rendering
│   ├── filter/       #   Graph filter panel
│   ├── discover/     #   Hierarchical node explorer
│   ├── physics/      #   Force-Atlas2 simulation controls
│   ├── toolbar/      #   Graph toolbar (layout, zoom)
│   ├── legend/       #   Node type legend
│   └── ...
├── appComponents/    # Full app-specific panels (GraphViewer, ChatPanel, etc.)
├── store/            # Graph store (LadybugDB WASM + context)
├── job/              # Job runners for indexing/import operations
├── graph/            # Graph computation hooks
├── hooks/            # Shared React hooks
├── gen/              # Generated protobuf types
└── styles/           # Global CSS
```

### Key Technologies

- **Pixi.js** — GPU-accelerated 2D graph rendering
- **Graphology** — In-memory graph data structure with Force-Atlas2 layout and Louvain community detection
- **tree-sitter (WASM)** — In-browser code parsing for 15 languages
- **LadybugDB** — Parquet-backed WASM graph store
- **LangChain** — LLM orchestration for chat and code summarization

## License

Apache-2.0
