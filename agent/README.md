# OpenTrace

[![PyPI - Version](https://img.shields.io/pypi/v/opentraceai)](https://pypi.org/project/opentraceai/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/opentrace/opentrace/blob/main/LICENSE)

Index any codebase into a knowledge graph — then query it with AI via MCP.

OpenTrace parses source code with [tree-sitter](https://tree-sitter.github.io/tree-sitter/), extracts classes, functions, imports, and call relationships, and stores the result in an embedded graph database. The graph is queryable through a built-in [MCP](https://modelcontextprotocol.io/) server, so tools like Claude Code can search, traverse, and understand your codebase structure.

## Install

```bash
pip install opentraceai
```

Or run directly with [uv](https://docs.astral.sh/uv/):

```bash
uvx opentraceai index .
```

Requires Python 3.12+.

## Quick Start

### 1. Index a codebase

```bash
opentraceai index /path/to/repo
```

This parses every supported file, extracts symbols and relationships, and writes the graph to `.opentrace/index.db`.

```
$ opentraceai index ~/projects/myapp
Opening database at .opentrace/index.db ...
Indexing /home/user/projects/myapp ...
  1284 nodes, 3421 relationships, 187 files, 95 classes, 412 functions
Done in 4.2s.
```

### 2. Query via MCP

Start a stdio MCP server against the indexed database:

```bash
opentraceai mcp
```

The database is auto-discovered by walking up from the current directory to the git root, looking for `.opentrace/index.db`. You can override with `--db <path>`.

### Claude Code

Add OpenTrace to Claude Code as a plugin, or configure it manually in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "opentrace": {
      "type": "stdio",
      "command": "uvx",
      "args": ["opentraceai", "mcp"]
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes by type (Class, Function, File, etc.) |
| `get_node` | Get a node's full details and immediate neighbors |
| `traverse_graph` | Walk relationships from a node (outgoing, incoming, or both) |
| `get_stats` | Graph statistics — node/edge counts broken down by type |

## Supported Languages

| Full extraction (symbols + calls + imports) | Structural extraction (symbols only) |
|---------------------------------------------|--------------------------------------|
| Python, TypeScript/JavaScript, Go | Rust, Java, Kotlin, C#, C/C++, Ruby, Swift |

Config and data files (JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash) are indexed as file nodes.

## CLI Reference

### `opentraceai index [PATH]`

Index a local codebase into a LadybugDB knowledge graph.

| Option | Default | Description |
|--------|---------|-------------|
| `PATH` | `.` | Directory to index |
| `--db` | `.opentrace/index.db` | Database path |
| `--repo-id` | directory name | Repository identifier |
| `--batch-size` | `200` | Items per write batch |
| `-v, --verbose` | off | Debug logging |

### `opentraceai mcp`

Start a stdio MCP server exposing graph query tools.

| Option | Default | Description |
|--------|---------|-------------|
| `--db` | auto-discovered | Database path |
| `-v, --verbose` | off | Debug logging |

### `opentraceai stats`

Display graph statistics (node/edge counts by type).

| Option | Default | Description |
|--------|---------|-------------|
| `--db` | auto-discovered | Database path |
| `--output` | `text` | Output format (`text` or `json`) |

### `opentraceai serve`

Start an HTTP server exposing the graph database as a REST API.

| Option | Default | Description |
|--------|---------|-------------|
| `--db` | auto-discovered | Database path |
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8787` | Bind port |
| `-v, --verbose` | off | Debug logging |

### `opentraceai query QUERY_STRING`

Run a Cypher or full-text search query against the graph database.

| Option | Default | Description |
|--------|---------|-------------|
| `--db` | auto-discovered | Database path |
| `-t, --type` | `cypher` | Query language (`cypher` or `fts`) |
| `--limit` | `100` | Max rows (FTS only) |
| `--output` | `table` | Output format (`table`, `json`, or `jsonl`) |

### `opentraceai export [OUTPUT]`

Export the graph database as a `.parquet.zip` archive.

### `opentraceai import ARCHIVE`

Import a `.parquet.zip` archive into the graph database.

### `opentraceai impact FILE_PATH`

Analyze the blast radius of changes to a file.

### `opentraceai config`

Read or write project configuration (`.opentrace/config.yaml`). Subcommands: `set`, `get`, `show`, `path`.

### `opentraceai login` / `logout` / `whoami` / `refresh`

Authenticate with api.opentrace.ai.

## Development

```bash
uv sync          # Install dependencies
uv run pytest    # Run tests
uv run ruff check src/ tests/   # Lint
uv run ruff format src/ tests/  # Format
```

## Part of OpenTrace

This package is the CLI/MCP component of [OpenTrace](https://github.com/opentrace/opentrace), an open-source platform for mapping system architecture into knowledge graphs. The full project also includes a browser-based graph explorer at [oss.opentrace.ai](https://oss.opentrace.ai).

## License

Apache License 2.0
