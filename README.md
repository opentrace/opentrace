# OpenTrace

[![Deploy](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml/badge.svg)](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml)
[![PyPI - Version](https://img.shields.io/pypi/v/opentraceai)](https://pypi.org/project/opentraceai/)
[![NPM Version](https://img.shields.io/npm/v/%40opentrace%2Fopentrace)](https://www.npmjs.com/package/@opentrace/opentrace)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A knowledge graph that maps your codebase structure, service architecture, and system relationships — then exposes it all through MCP so AI tools can understand your systems.

<video src="https://github.com/user-attachments/assets/ec71e310-b878-4691-bf3b-d8b054f452b6" controls width="100%"></video>

<p align="center"><em>Index any repo, any size, in seconds. Build a knowledge graph and watch your LLM fetch true codebase context in realtime.</em></p>

## Try Now

**[oss.opentrace.ai](https://oss.opentrace.ai)** — no install required, runs entirely in your browser.

**[Docs](https://opentrace.github.io/opentrace/)** — getting started, architecture, and reference guides

## Quick Start

### Browser (no install)

Visit **[oss.opentrace.ai](https://oss.opentrace.ai)**, add a GitHub repo, and explore the graph.

### Claude Code Plugin

```bash
claude plugin marketplace add https://github.com/opentrace/opentrace 
claude plugin install opentrace-oss@opentrace-oss
```

> We will automatically start an index in the background on session start.

Then index your codebase and start exploring:

```bash
uvx opentraceai index        # index the current repo
```

The plugin gives Claude Code 5 agents, 4 slash commands, and graph query tools — see [Claude Code Plugin](#claude-code-plugin) for details.

### CLI Agent (standalone)

```bash
uv tool install opentraceai --upgrade   # install or upgrade the CLI
opentraceai index /path/to/repo
opentraceai mcp             # start MCP server for any compatible client
```

The database is stored at `.opentrace/index.db` and auto-discovered by all commands.

### Run from Source

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

Everything runs in the browser — no server required.

```
┌───────────────────────────────────────────────────────────┐
│                      UI (React/TS)                        │
│            Browser-based indexer + graph explorer         │
│               localhost:5173 / oss.opentrace.ai           │
│                                                           │
│  ┌───────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │  Web Worker   │  │  LadybugDB WASM │  │  Chat Agent  │ │
│  │  tree-sitter  │  │  (embedded      │  │  LLM-powered │ │
│  │  WASM parsers │  │   graph store)  │  │  graph tools │ │
│  └───────────────┘  └─────────────────┘  └──────────────┘ │
└───────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│                 Claude Code Plugin (MCP)                  │
│     Python agent exposes graph tools via MCP protocol     │
│         uvx opentraceai mcp  →  stdio transport           │
└───────────────────────────────────────────────────────────┘
```

## Supported Languages

| Full Extraction (symbols + calls + imports) | Structural Extraction (symbols only) |
|---|---|
| Python, TypeScript/JavaScript, Go | Rust, Java, Kotlin, C#, C/C++, Ruby, Swift |

Config and data files (JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash) are indexed as file nodes.

## Graph Tools

### Browser Chat Agent

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name, properties, and file content |
| `list_nodes` | List nodes by type with optional property filters |
| `get_node` | Get full details of a single node by ID |
| `traverse_graph` | BFS traversal to discover connected nodes and relationships |
| `load_source` | Fetch source code for an indexed file or symbol |
| `explore_node` | Deep inspection — node details + relationships + source in one call |
| `grep` | Regex search across all indexed source files |

### Claude Code Plugin (MCP)

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes of a specific type |
| `get_node` | Get full details of a single node by ID |
| `traverse_graph` | BFS traversal with direction and relationship filters |
| `get_stats` | Graph statistics — total nodes, edges, and breakdown by type |

## Repository Structure

```
ui/                   — React/TypeScript frontend (graph explorer + browser indexer)
agent/                — Python agent (CLI + MCP server for Claude Code)
proto/                — Protobuf definitions (shared schema)
claude-code-plugin/   — Claude Code plugin (agents, commands, skills, hooks)
docs/                 — Documentation site (mkdocs-material)
tests/                — Cross-validation test fixtures
benchmark/            — Accuracy benchmarks
```

## Development

### Prerequisites

- Node.js 22+ (see `ui/.nvmrc`)
- npm

### Commands

```bash
make install          # Install dependencies (agent + ui)
make agent            # Run Python agent
make ui               # Start dev server (localhost:5173)
make build            # Production build
make test             # Run all tests (agent + ui)
make fmt              # Format all code
make lint             # Lint all code
make proto            # Generate protobuf types
make ui-build-static  # Static build (browser-only, no API dependency)
make license-check    # Verify Apache 2.0 headers on all source files
make plugin-reload    # Reinstall the Claude Code plugin locally
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
| `@opentrace`           | Default catch-all — any codebase question routed to the knowledge graph                   |
| `@code-explorer`       | Explore indexed code structure — find classes, functions, files, and their relationships   |
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes                                     |
| `@find-usages`         | Find all callers, references, and usages of a component                                    |
| `@explain-service`     | Top-down walkthrough of how a service or module works                                      |

## Commands

| Command             | Description                                                     |
| ------------------- | --------------------------------------------------------------- |
| `/graph-status`     | Show overview of indexed nodes by type, list repos and services |
| `/explore <name>`   | Quick exploration of a named component in the graph             |
| `/index`            | Index (or re-index) the current project into the knowledge graph |
| `/interrogate`      | Answer a question about the codebase without making changes      |

## Graph Node Types

Repository, Directory, File, Class, Function, Variable, Dependency, PullRequest, IndexMetadata

## Claude Code Plugin

OpenTrace ships a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that connects Claude to an OpenTrace MCP server.

```bash
claude plugin marketplace add https://github.com/opentrace/opentrace
claude plugin install opentrace-oss@opentrace-oss
```

The plugin provides 5 agents, 4 slash commands, and MCP graph tools. See `claude-code-plugin/` for full documentation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
