# OpenTrace

Monorepo for the OpenTrace platform — a knowledge graph that maps system architecture, code structure, and service relationships.

## Repository Structure

```
api/     — Go backend (MCP server, graph store, REST API)
agent/   — Python agent (loads data into the graph)
ui/      — React/TypeScript frontend
proto/   — Protobuf definitions
```

## Building & Running

```bash
# Build everything
make build

# Run individual components
make api       # Start Go API server (port 8080)
make agent     # Run Python agent
make ui        # Start React dev server (port 5173–5180, auto-detected)

# Run all tests
make test
```

### API Server

```bash
cd api
go build ./cmd/server
go test ./...
```

KuzuDB (embedded graph database) requires the shared library in `LD_LIBRARY_PATH` for tests:

```bash
LD_LIBRARY_PATH=$(go env GOPATH)/pkg/mod/github.com/kuzudb/go-kuzu@v0.11.3/lib/dynamic/linux-amd64/ go test ./...
```

### Agent

```bash
cd agent
uv sync          # Install dependencies
uv run pytest    # Run tests
```

### UI

```bash
cd ui
npm install
npm run dev
```

#### Worktree & port handling

`ui/vite.config.ts` has a worktree-aware helper:

- **`resolveEnvDir()`** — `.env` is gitignored so it only exists in the main working tree. When running from a worktree, falls back to the main tree's `.env` via `git worktree list --porcelain`.
- **Port** — defaults to 5173. Set `PORT=5174 npm run dev` to use a different port (e.g. when running multiple worktrees). Uses `strictPort: true` so Vite errors if the port is taken.

## MCP Tools

The API server exposes an MCP endpoint at `/mcp` with these tools:

| Tool             | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `query_graph`    | Search or list nodes by type with optional property filters      |
| `get_node`       | Fetch a single node by ID with its immediate neighbors           |
| `traverse_graph` | Walk relationships from a starting node (outgoing/incoming/both) |
| `search_graph`   | Search nodes by name and return a subgraph with relationships    |
| `load_source`    | Fetch file contents from registered GitHub/GitLab integrations   |

## Agents

| Agent                  | Description                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `@code-explorer`       | Explore indexed code structure — find classes, functions, services and their relationships |
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes                                     |

## Commands

| Command           | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `/graph-status`   | Show overview of indexed nodes by type, list repos and services |
| `/explore <name>` | Quick exploration of a named component in the graph             |

## Graph Node Types

Service, Repo, Repository, Class, Module, Function, File, Directory, Cluster, Namespace, Deployment, InstrumentedService, Span, Log, Metric, Endpoint, Database, DBTable

## Configuration

Server config is in `config.yaml`:

```yaml
server:
  port: 8080
  env: dev
  cors_hosts:
    - http://localhost:5173 # UI auto-selects 5173–5180; add more if needed
graph:
  db_path: ./data/graph.kuzu
```
