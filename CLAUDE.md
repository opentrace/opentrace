# OpenTrace

Monorepo for the OpenTrace platform — a knowledge graph that maps system architecture, code structure, and service relationships.

## Repository Structure

```
ui/          — React/TypeScript frontend
components/  — @opentrace/components (graph visualization library)
agent/       — Python agent (loads data into the graph)
proto/       — Protobuf definitions
```

## Building & Running

```bash
# Build everything
make build

# Run individual components
make agent     # Run Python agent
make ui        # Start React dev server (port 5173–5180, auto-detected)

# Run all tests
make test
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
