# Development Setup

## Prerequisites

- Node.js 22+ (see `ui/.nvmrc`)
- npm
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) (for the agent)

## Getting Started

```bash
git clone https://github.com/opentrace/opentrace.git
cd opentrace
make install
```

## Commands

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

## Running Tests

```bash
cd ui
npm test              # Run all tests
npm run lint          # ESLint + Prettier check
```

## Repository Structure

```
ui/                   — React/TypeScript frontend (graph explorer + browser indexer)
agent/                — Python agent (loads data into the graph)
proto/                — Protobuf definitions (shared API contracts)
plugins/              — Editor / AI integrations
  claude-code/        — Claude Code plugin (MCP server config)
benchmark/            — Performance benchmarks
```
