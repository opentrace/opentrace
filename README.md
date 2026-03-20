# OpenTrace

[![Deploy](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml/badge.svg)](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml)
[![PyPI - Version](https://img.shields.io/pypi/v/opentraceai)](https://pypi.org/project/opentraceai/)
[![NPM Version](https://img.shields.io/npm/v/%40opentrace%2Fcomponents)](https://www.npmjs.com/package/@opentrace/components)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A knowledge graph that maps your codebase structure, service architecture, and system relationships — then exposes it all through MCP so AI tools can understand your systems.

## Try Now

**[oss.opentrace.ai](https://oss.opentrace.ai)** — no install required, runs entirely in your browser.

**[Docs](https://opentrace.github.io/opentrace/reference/chat-providers/)** - for help and support

## Quick Start

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
│                                  │  LadybugDB WASM    │ │
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
make ui               # Start dev server (localhost:5173)
make build            # Production build
make test             # Run tests
make fmt              # Format code
make lint             # Lint
make proto            # Generate protobuf types
make ui-build-static  # Static build (no API server dependency)
```

### Running Tests

```bash
cd ui
npm test              # Run all tests
npm run lint          # ESLint + Prettier check
```

## Claude Code Plugin

OpenTrace ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that connects Claude to an OpenTrace MCP server. See `claude-code-plugin/` for configuration.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
