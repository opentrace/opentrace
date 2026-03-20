# OpenTrace

A knowledge graph that maps your codebase structure, service architecture, and system relationships — then exposes it all through MCP so AI tools can understand your systems.

**[Try it now at oss.opentrace.ai](https://oss.opentrace.ai)** — no install required, runs entirely in your browser.

## What It Does

OpenTrace indexes source code directly in your browser — no server required. Point it at a GitHub or GitLab repo and it will:

1. **Parse** every file using tree-sitter WASM grammars (12 languages)
2. **Extract** classes, functions, imports, and call relationships
3. **Build** a knowledge graph stored in LadybugDB WASM (embedded graph database)
4. **Summarize** every node using template-based identifier analysis
5. **Expose** the graph to an in-app chat agent via MCP tools

## Quick Start

```bash
git clone https://github.com/opentrace/opentrace.git
cd opentrace
make install
make ui
```

Open [http://localhost:5173](http://localhost:5173), add a GitHub repo, and explore the graph.

## License

Apache License 2.0 — see [LICENSE](https://github.com/opentrace/opentrace/blob/main/LICENSE) for details.
