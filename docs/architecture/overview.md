# Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    UI (React/TS)                     │
│         Browser-based indexer + graph explorer       │
│           localhost:5173         ┌─────────────────┐ │
│                                  │  Web Worker     │ │
│                                  │  tree-sitter    │ │
│                                  │  WASM parsers   │ │
│                                  └─────────────────┘ │
│                                  ┌─────────────────┐ │
│                                  │  LadybugDB WASM    │ │
│                                  │  graph store    │ │
│                                  └─────────────────┘ │
└──────────────────────────────────────────────────────┘
```

## Components

### UI (`ui/`)

React/TypeScript frontend that runs entirely in the browser. Includes:

- **Graph Explorer** — visual graph navigation and search
- **Tree-sitter Web Worker** — parses source files using WASM grammars
- **LadybugDB WASM** — embedded graph database for storing and querying the knowledge graph
- **Chat Agent** — in-app AI agent with access to graph tools via MCP

### Protobuf Definitions (`proto/`)

Shared API contracts used across components.

### Claude Code Plugin (`claude-code-plugin/`)

MCP server configuration that connects Claude Code to OpenTrace.
