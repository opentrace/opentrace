# OpenTrace

A knowledge graph that maps your codebase structure, service architecture, and system relationships — then exposes it all through MCP so AI tools can understand your systems.

**[Try it now at app.opentrace.ai](https://app.opentrace.ai)** — no install required, runs entirely in your browser.

## Where to Start

| Goal                                | Start here                                                 |
| ----------------------------------- | ---------------------------------------------------------- |
| See what OpenTrace is               | [Browser (no install)](getting-started/install-browser.md) |
| Give Claude Code codebase awareness | [Claude Code Plugin](getting-started/install-plugin.md)    |
| Index repos from a terminal         | [CLI](getting-started/install-cli.md)                      |
| Hack on OpenTrace itself            | [Development Setup](development/setup.md)                  |

Not sure? → [Pick Your Path](getting-started/quickstart.md)

## What It Does

OpenTrace indexes source code and builds a queryable knowledge graph. Point it at a repo and it will:

1. **Parse** every file using tree-sitter WASM grammars (12 languages)
2. **Extract** classes, functions, imports, and call relationships
3. **Build** a knowledge graph stored in LadybugDB (embedded graph database)
4. **Summarize** every node using template-based identifier analysis
5. **Expose** the graph via MCP tools to any compatible AI client

See [Architecture Overview](architecture/overview.md) for how the pieces fit together.

## Learn More

- **[Graph Tools](reference/graph-tools.md)** — the MCP tools exposed to AI agents
- **[Supported Languages](reference/languages.md)** — full vs. structural extraction
- **[Claude Code Plugin](reference/claude-code-plugin.md)** — agents, commands, and tools
- **[Browser Requirements](reference/browser-requirements.md)** — why Safari doesn't work
- **[Contributing](development/contributing.md)** — help improve OpenTrace

## Source

OpenTrace is open source under Apache 2.0 — [github.com/opentrace/opentrace](https://github.com/opentrace/opentrace).
