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

This parses every supported file, extracts symbols and relationships, and writes the graph to `./otindex.db`.

```
$ opentraceai index ~/projects/myapp
Opening LadybugDB at ./otindex.db ...
Indexing /home/user/projects/myapp ...
  1284 nodes, 3421 relationships, 187 files, 95 classes, 412 functions
Done in 4.2s.
```

### 2. Query via MCP

Start a stdio MCP server against the indexed database:

```bash
opentraceai mcp --db ./otindex.db
```

This exposes graph query tools over stdin/stdout for any MCP-compatible client.

### Claude Code

Add OpenTrace to Claude Code as a plugin, or configure it manually in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "opentrace": {
      "type": "stdio",
      "command": "uvx",
      "args": ["opentraceai", "mcp", "--db", "./otindex.db"]
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_graph` | Full-text search across nodes by name or properties |
| `list_nodes` | List nodes by type (Class, Function, Service, etc.) |
| `get_node` | Get a node's full details and immediate neighbors |
| `traverse_graph` | Walk relationships from a node (outgoing, incoming, or both) |
| `get_stats` | Get graph statistics — node/edge counts broken down by type |

## Supported Languages

| Full extraction (symbols + calls + imports) | Structural extraction (symbols only) |
|---------------------------------------------|--------------------------------------|
| Python, TypeScript/JavaScript, Go | Rust, Java, Kotlin, C#, C/C++, Ruby, Swift |

Config and data files (JSON, YAML, TOML, Protobuf, SQL, GraphQL, Bash) are indexed as file nodes.

## CLI Reference

```
opentraceai index [PATH] [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `PATH` | `.` | Directory to index |
| `--db` | `./otindex.db` | Database path |
| `--repo-id` | directory name | Repository identifier |
| `--batch-size` | 200 | Items per write batch |
| `-v, --verbose` | off | Debug logging |

```
opentraceai mcp [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--db` | `./otindex.db` | Database path |
| `-v, --verbose` | off | Debug logging |

## Part of OpenTrace

This package is the CLI/MCP component of [OpenTrace](https://github.com/opentrace/opentrace), an open-source platform for mapping system architecture into knowledge graphs. The full project also includes a browser-based graph explorer at [oss.opentrace.ai](https://oss.opentrace.ai).

## License

Apache License 2.0
