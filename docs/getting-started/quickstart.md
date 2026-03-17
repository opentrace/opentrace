# Quick Start

## Prerequisites

- Node.js 22+ (see `ui/.nvmrc`)
- npm

## Installation

```bash
git clone https://github.com/opentrace/opentrace.git
cd opentrace
make install
make ui
```

Open [http://localhost:5173](http://localhost:5173), add a GitHub repo, and explore the graph.

## What Happens

When you add a repository, OpenTrace will:

1. Fetch the source code via the GitHub/GitLab API
2. Parse every file using tree-sitter WASM grammars
3. Extract symbols (classes, functions, imports) and relationships
4. Build a knowledge graph in an embedded KuzuDB instance
5. Make the graph available for exploration and querying
