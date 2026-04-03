# OpenTrace

[![Deploy](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml/badge.svg)](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml)
[![PyPI - Version](https://img.shields.io/pypi/v/opentraceai)](https://pypi.org/project/opentraceai/)
[![NPM Version](https://img.shields.io/npm/v/%40opentrace%2Fcomponents)](https://www.npmjs.com/package/@opentrace/components)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A knowledge graph that maps your codebase structure, service architecture, and system relationships — then exposes it all through MCP so AI tools can understand your systems.

## Try Now

**[oss.opentrace.ai](https://oss.opentrace.ai)** — no install required, runs entirely in your browser.

**[Docs](https://opentrace.github.io/opentrace/reference/chat-providers/)** - for help and support

## Quick Start MCP in Local Project

Chat with AI about your local project, using the knowledge graph, integrated with your local tooling.

~~~bash
cd $PROJECT_DIR
uvx opentraceai index .

# Claude users: install plugin
claude plugin marketplace add https://github.com/opentrace/opentrace
claude plugin install opentrace-oss@opentrace-oss

# Gemini user: configure MCP
# - change scope from 'project' to 'user' to add it for all projects
gemini mcp add --scope project opentraceai uvx opentraceai mcp
~~~

The next time claude or gemini is started, it will have opentrace configured.

See [agent/README.md](agent/README.md) for more information on using the `opentraceai` agent, and [claude-code-plugin/README.md](claude-code-plugin/README.md) for more on configuring it as an MCP plugin.

## Quick Start the Web UI

```bash
git clone https://github.com/opentrace/opentrace.git
cd opentrace
make install
make ui
```

Open [http://localhost:5173](http://localhost:5173), add a GitHub repo, and explore the graph.

## What It Does

OpenTrace indexes source code directly in your browser — no server required. Point it at a GitHub or GitLab repo and it will:

1. **Parse** every file using tree-sitter WASM grammars (12 languages)
2. **Extract** classes, functions, imports, and call relationships
3. **Build** a knowledge graph stored in LadybugDB WASM (embedded graph database)
4. **Summarize** every node using template-based identifier analysis
5. **Expose** the graph to an in-app chat agent via MCP tools

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
│                                  │  LadybugDB WASM │ │
│                                  │  graph store    │ │
│                                  └─────────────────┘ │
└──────────────────────────────────────────────────────┘
```

## Supported Languages

| Full Extraction (symbols + calls + imports) | Structural Extraction (symbols only) |
|---|---|
| Python, TypeScript/JavaScript, Go | Rust, Java, Kotlin, C#, C/C++, Ruby, Swift |

Config and data files (JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash) are indexed as file nodes.

## Graph Tools

The built-in chat agent has access to these tools:

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes by type with optional property filters |
| `get_node` | Get full details of a single node by ID |
| `traverse_graph` | BFS traversal to discover connected nodes |
| `load_source` | Fetch source code for an indexed file or symbol |

## Repository Structure

```
ui/                   — React/TypeScript frontend (graph explorer + browser indexer)
agent/                — Python agent (loads data into the graph)
proto/                — Protobuf definitions (shared API contracts)
claude-code-plugin/   — Claude Code plugin (MCP server config)
```

## Development

### Prerequisites

- Node.js 22+ (see `ui/.nvmrc`)
- npm

### Commands

```bash
make install          # Install dependencies
make agent            # Run Python agent
make ui               # Start dev server (localhost:5173)
make build            # Production build
make test             # Run tests
make fmt              # Format code
make lint             # Lint
make proto            # Generate protobuf types
make ui-build-static  # Static build (no API server dependency)
```

### Agent

```bash
cd agent
uv sync          # Install dependencies
uv run pytest    # Run tests
```

### Running Tests

```bash
cd ui
npm test              # Run all tests
npm run lint          # ESLint + Prettier check
```

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

## Claude Code Plugin

OpenTrace ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that connects Claude to an OpenTrace MCP server. See `claude-code-plugin/` for configuration.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
