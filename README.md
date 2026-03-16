# OpenTrace

A knowledge graph that maps your codebase structure, service architecture, and system relationships — then exposes it all through MCP so AI tools can understand your systems.

## Architecture

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
│                                  │  KuzuDB WASM    │ │
│                                  │  graph store    │ │
│                                  └─────────────────┘ │
└──────────────────────────────────────────────────────┘
```

> **Planned:** A Go API server (MCP endpoint, persistent graph store) and a
> Python agent (LangGraph pipeline, data loaders) are under development but not
> yet included in the open-source repo.

## Quick Start

```bash
# Clone and install
git clone https://github.com/opentrace/opentrace.git
cd opentrace
make install   # installs npm dependencies

# Start the UI
make ui
```

Open [http://localhost:5173](http://localhost:5173), point the indexer at a GitHub repo, and explore the graph.

## Repository Structure

```
ui/                   — React/TypeScript frontend (graph explorer + browser indexer)
proto/                — Protobuf definitions (shared API contracts)
claude-code-plugin/   — Claude Code plugin (MCP server config)
tests/                — Cross-validation and integration test fixtures
```

## Components

### `ui/` — React/TypeScript Frontend

Graph explorer with a built-in browser-based code indexer. The indexer runs tree-sitter WASM parsers inside a Web Worker to extract symbols, calls, and relationships directly in the browser — no server-side processing needed.

The graph is stored in-browser using **KuzuDB WASM** — an embedded graph database compiled to WebAssembly. An in-memory store is also available as a fallback (no WASM, no COOP/COEP headers required).

```bash
cd ui
npm install
npm run dev
```

### `proto/` — Protobuf Definitions

Shared API contracts for the platform. Currently generates TypeScript types for the UI:

```bash
make proto   # generates TS types (py/go targets run when agent/api dirs exist)
```

## Graph Tools

The UI exposes these graph tools to the built-in chat agent:

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across graph nodes by name or properties |
| `list_nodes` | List nodes of a specific type with optional property filters |
| `get_node` | Get full details of a single node by its ID |
| `traverse_graph` | BFS traversal from a node to discover connected nodes and relationships |
| `load_source` | Fetch source code for an indexed file or symbol |

## Claude Code Plugin

OpenTrace ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that connects Claude to an OpenTrace MCP server.

The plugin is configured in `claude-code-plugin/.mcp.json` and points to `http://localhost:8080/mcp`.

## Supported Languages

The browser-based indexer parses source code using tree-sitter WASM grammars. Languages with **full extraction** get symbol-level detail (classes, functions, calls, imports). Others get **structural extraction** (classes and functions, no call graph).

| Full Extraction | Structural Extraction |
|---|---|
| Python, TypeScript/JavaScript, Go | Rust, Java, Kotlin, C#, C/C++, Ruby, Swift |

Config and data files (JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash) are indexed as file nodes.

## Development

```bash
# Build the UI
make build

# Run tests
make test

# Format code
make fmt

# Lint
make lint

# Generate protobuf code
make proto
```

### Static / Browser-Only Build

Build the UI without an API server dependency (all indexing runs in-browser):

```bash
make ui-build-static
```

### Graph Node Types

`Service` `Repo` `Repository` `Class` `Module` `Function` `File` `Directory` `Cluster` `Namespace` `Deployment` `InstrumentedService` `Span` `Log` `Metric` `Endpoint` `Database` `DBTable`
