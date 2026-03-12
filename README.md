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
└──────────────────┬───────────────────────────────────┘
                   │ REST + MCP
┌──────────────────▼───────────────────────────────────┐
│                  API Server (Go)                     │
│       MCP endpoint  ·  REST API  ·  Graph store      │
│           localhost:8080                             │
│  ┌─────────────┐  ┌─────────────┐                    │
│  │  KuzuDB     │  │  In-Memory  │  (switchable)      │
│  │  (embedded) │  │  Store      │                    │
│  └─────────────┘  └─────────────┘                    │
└──────────────────┬───────────────────────────────────┘
                   │ gRPC
┌──────────────────▼───────────────────────────────────┐
│               Agent (Python)                         │
│     LangGraph pipeline  ·  data loaders              │
│         GitHub · GitLab · Linear                     │
└──────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Clone and install
git clone https://github.com/opentrace/opentrace.git
cd opentrace

# Start the API server (uses in-memory graph store by default)
make api

# In another terminal, start the UI
make ui
```

Open [http://localhost:5173](http://localhost:5173), point the indexer at a GitHub repo, and explore the graph.

## Repository Structure

```
api/                  — Go backend (MCP server, graph store, REST API)
agent/                — Python agent (LangGraph pipeline, data loaders)
ui/                   — React/TypeScript frontend (graph explorer + browser indexer)
proto/                — Protobuf definitions (shared API contracts)
claude-code-plugin/   — Claude Code plugin (agents + slash commands)
tests/                — Cross-validation and integration test fixtures
```

## Components

### `api/` — Go Backend

MCP server, REST API, and graph storage. Two interchangeable store backends:

- **KuzuDB** — embedded graph database for persistent storage (requires CGo)
- **In-Memory** — pure Go, no dependencies, used for dev/test

```bash
cd api
go build ./cmd/server       # memory store only
go build -tags kuzu ./cmd/server  # with KuzuDB support
```

### `ui/` — React/TypeScript Frontend

Graph explorer with a built-in browser-based code indexer. The indexer runs tree-sitter WASM parsers inside a Web Worker to extract symbols, calls, and relationships directly in the browser — no server-side processing needed.

```bash
cd ui
npm install
npm run dev
```

### `agent/` — Python Agent

LangGraph-based pipeline that loads data from external sources (GitHub, GitLab, Linear) into the graph. Uses `uv` for package management.

```bash
cd agent
uv sync
uv run pytest
```

## MCP Tools

The API server exposes an MCP endpoint at `/mcp` with these tools:

| Tool | Description |
|------|-------------|
| `query_graph` | Search or list nodes by type with optional property filters |
| `get_node` | Fetch a single node by ID with its immediate neighbors |
| `traverse_graph` | Walk relationships from a starting node (outgoing/incoming/both) |
| `search_graph` | Search nodes by name and return a subgraph with relationships |
| `load_source` | Fetch file contents from registered GitHub/GitLab integrations |

Connect any MCP-compatible client to `http://localhost:8080/mcp` to query the graph.

## Claude Code Plugin

OpenTrace ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that gives Claude direct access to the knowledge graph.

**Agents:**

| Agent | Description |
|-------|-------------|
| `@code-explorer` | Explore indexed code structure — find classes, functions, services and their relationships |
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes |

**Commands:**

| Command | Description |
|---------|-------------|
| `/graph-status` | Show overview of indexed nodes by type, list repos and services |
| `/explore <name>` | Quick exploration of a named component in the graph |

## Supported Languages

The browser-based indexer parses source code using tree-sitter WASM grammars. Languages with **full extraction** get symbol-level detail (classes, functions, calls, imports). Others get **structural extraction** (classes and functions, no call graph).

| Full Extraction | Structural Extraction |
|---|---|
| Python, TypeScript/JavaScript, Go | Rust, Java, Kotlin, C#, C/C++, Ruby, Swift |

Config and data files (JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash) are indexed as file nodes.

## Configuration

Server config lives in `config.yaml` at the repo root:

```yaml
server:
  port: 8080
  env: dev
  request_timeout: 60s
  cors_hosts:
    - http://localhost:5173

graph:
  # Set db_path for KuzuDB persistent storage.
  # Omit or leave empty for in-memory store.
  db_path: ./data/graph.kuzu

agent:
  address: localhost:50051
```

## Development

```bash
# Build all components
make build

# Run all tests
make test

# Format code
make fmt

# Lint
make lint

# Generate protobuf code
make proto
```

### Running API tests with KuzuDB

KuzuDB requires its shared library on the library path:

```bash
LD_LIBRARY_PATH=$(go env GOPATH)/pkg/mod/github.com/kuzudb/go-kuzu@v0.11.3/lib/dynamic/linux-amd64/ \
  go test ./...
```

### Static / Browser-Only Build

Build the UI without an API server dependency (all indexing runs in-browser):

```bash
make ui-build-static
```

### Graph Node Types

`Service` `Repo` `Repository` `Class` `Module` `Function` `File` `Directory` `Cluster` `Namespace` `Deployment` `InstrumentedService` `Span` `Log` `Metric` `Endpoint` `Database` `DBTable`
