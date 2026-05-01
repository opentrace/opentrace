# OpenTrace

[![Deploy](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml/badge.svg)](https://github.com/opentrace/opentrace/actions/workflows/deploy.yml)
[![PyPI - Version](https://img.shields.io/pypi/v/opentraceai)](https://pypi.org/project/opentraceai/)
[![NPM Version](https://img.shields.io/npm/v/%40opentrace%2Fopentrace)](https://www.npmjs.com/package/@opentrace/opentrace)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

A knowledge graph that maps your codebase structure, service architecture, and system relationships — then exposes it all through MCP so AI tools can understand your systems.

<video src="https://github.com/user-attachments/assets/ec71e310-b878-4691-bf3b-d8b054f452b6" controls width="100%"></video>

<p align="center"><em>Index any repo, any size, in seconds. Build a knowledge graph and watch your LLM fetch true codebase context in realtime.</em></p>

## What It Does

OpenTrace indexes source code and builds a queryable knowledge graph. Point it at a repo and it will:

1. **Parse** every file using tree-sitter WASM grammars (12 languages)
2. **Extract** classes, functions, imports, and call relationships
3. **Build** a knowledge graph stored in LadybugDB (embedded graph database)
4. **Summarize** every node using template-based identifier analysis
5. **Expose** the graph via MCP tools to any compatible AI client

## Get Started

### Linux/MacOS

```sh
uvx opentraceai index .   # Index a local project for use with MCP etc
```

### Claude Plugin

```
/plugin marketplace add https://github.com/opentrace/opentrace
/plugin install opentrace-oss@opentrace-oss
/reload-plugins
```

More info: https://opentrace.github.io/opentrace/getting-started/install-plugin/

### OpenCode Plugin

Add to `~/.config/opencode/opencode.json`:

~~~jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@opentrace/opencode"]
}
~~~

More info: https://opentrace.github.io/opentrace/getting-started/install-opencode/

### Gemini CLI

```sh
gemini mcp add opentraceai uvx opentraceai mcp
```

### Run Completely in the Browser

**No install:** **[app.opentrace.ai](https://app.opentrace.ai)**

### Run UI Locally

```sh
git clone https://github.com/opentrace/opentrace.git && cd opentrace
make install && make ui  # Runs on http://localhost:5173/
```

### More Information

**Full documentation:** **[opentrace.github.io/opentrace](https://opentrace.github.io/opentrace/)** — install guides, architecture, and reference.

**Prerequisites:** plugins and CLI need [`uv`](https://docs.astral.sh/uv/); OpenCode plugin runs in [Bun](https://bun.sh) (provided by OpenCode itself). Source build also needs Node 22+ and Python 3.12+. See [Troubleshooting](https://opentrace.github.io/opentrace/getting-started/troubleshooting/) if anything fails.

## Claude Code Plugin

The plugin gives Claude Code 5 agents, 4 slash commands, and MCP graph tools.

| Agent                  | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `@opentrace`           | Default catch-all — any codebase question routed to the knowledge graph            |
| `@code-explorer`       | Explore indexed code structure — find classes, functions, files, and relationships |
| `@dependency-analyzer` | Analyze dependencies and blast radius for code changes                             |
| `@find-usages`         | Find all callers, references, and usages of a component                            |
| `@explain-service`     | Top-down walkthrough of how a service or module works                              |

| Command           | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| `/index`          | Index (or re-index) the current project into the knowledge graph |
| `/graph-status`   | Show overview of indexed nodes by type                           |
| `/explore <name>` | Quick exploration of a named component in the graph              |
| `/interrogate`    | Answer a question about the codebase without making changes      |

Full details: [Claude Code Plugin reference](https://opentrace.github.io/opentrace/reference/claude-code-plugin/).

## OpenCode Plugin

The plugin gives [OpenCode](https://opencode.ai) 9 native tools and three hooks (system-prompt, tool-execute, auth) — calls the `opentraceai` CLI directly rather than going through MCP.

| Tool                          | Description                                                          |
| ----------------------------- | -------------------------------------------------------------------- |
| `opentrace_source_search`     | Symbol-level search across indexed code                              |
| `opentrace_semantic_search`   | Embedding-based search over node descriptions                        |
| `opentrace_source_read`       | Read source for a graph node by ID                                   |
| `opentrace_source_grep`       | Grep across indexed source content                                   |
| `opentrace_repo_index`        | Index a local path or remote git URL into the graph                  |
| `opentrace_find_usages`       | Find all callers and references of a component                       |
| `opentrace_impact_analysis`   | Blast radius analysis for a proposed change                          |
| `opentrace_graph_explore`     | BFS traversal with direction and depth controls                      |
| `opentrace_graph_stats`       | Node and edge counts by type                                         |

Full details: [OpenCode Plugin reference](https://opentrace.github.io/opentrace/reference/opencode-plugin/).

## Supported Languages

**Full extraction** (symbols + calls + imports): Python, TypeScript/JavaScript, Go
**Structural extraction** (symbols only): Rust, Java, Kotlin, C#, C/C++, Ruby, Swift
**Indexed as file nodes**: JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash

Full language matrix: [Supported Languages](https://opentrace.github.io/opentrace/reference/languages/).

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                      UI (React/TS)                        │
│            Browser-based indexer + graph explorer         │
│               localhost:5173 / app.opentrace.ai           │
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

┌───────────────────────────────────────────────────────────┐
│                  OpenCode Plugin (native)                 │
│      TS plugin in OpenCode's Bun runtime — 9 tools +      │
│         system-prompt, tool-execute, auth hooks           │
│           opentraceai CLI  →  spawn (no MCP)              │
└───────────────────────────────────────────────────────────┘
```

See [Architecture Overview](https://opentrace.github.io/opentrace/architecture/overview/) for details.

## Repository Structure

```
ui/                   — React/TypeScript frontend (graph explorer + browser indexer)
agent/                — Python agent (CLI + MCP server for Claude Code)
proto/                — Protobuf definitions (shared schema)
plugins/              — Editor / AI integrations
  claude-code/        — Claude Code plugin (agents, commands, skills, hooks)
  opencode/           — OpenCode plugin (native TS, Bun runtime)
docs/                 — Documentation site (mkdocs-material)
tests/                — Cross-validation test fixtures
benchmark/            — Accuracy benchmarks
```

## Development

See [Development Setup](https://opentrace.github.io/opentrace/development/setup/) for prerequisites, commands, and the full dev workflow.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
