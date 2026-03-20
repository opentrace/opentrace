# @opentrace/components

Shared library for the [OpenTrace](https://github.com/opentrace/opentrace) platform. Ships two independent feature sets:

1. **Graph visualization** — React components powered by Sigma.js and Graphology
2. **Ingest pipeline** — framework-free code parsing pipeline (no React required)

## Installation

```bash
npm install @opentrace/components
```

## Entry points

| Import path | Needs React | Description |
|---|---|---|
| `@opentrace/components` | Yes | Graph visualization components |
| `@opentrace/components/pipeline` | No | Code parsing & knowledge graph pipeline |
| `@opentrace/components/pipeline/wasm` | No (Node.js only) | WASM file path helpers |
| `@opentrace/components/utils` | No | Shared utility functions |
| `@opentrace/components/indexing` | Yes | Indexing UI components |
| `@opentrace/components/style.css` | — | Base CSS styles |

---

## Graph visualization

Interactive knowledge graph renderer built on [Sigma.js](https://www.sigmajs.org/).

### Quick start

```tsx
import { GraphCanvas } from '@opentrace/components';
import '@opentrace/components/style.css';

const data = {
  nodes: [
    { id: '1', type: 'Service', name: 'api-gateway', properties: {} },
    { id: '2', type: 'Service', name: 'user-service', properties: {} },
  ],
  links: [
    { source: '1', target: '2', type: 'CALLS', id: 'e1' },
  ],
};

function App() {
  return <GraphCanvas data={data} height={600} />;
}
```

### Components

- **`GraphCanvas`** — main graph renderer with layout, filtering, and interaction
- **`FilterPanel`** — node type / relationship type filter controls
- **`GraphToolbar`** — zoom, fit, layout toggle controls
- **`GraphLegend`** — color legend for node types
- **`GraphBadge`** — node/edge count badge
- **`DiscoverPanel`** — tree-based graph explorer
- **`AddRepoModal`** — repository URL input modal
- **`IndexingProgress`** — multi-stage indexing progress display

### Hooks

- `useGraphInstance` — access the underlying Graphology/Sigma instances
- `useGraphFilters` — manage filter state
- `useGraphVisuals` — control visual properties (colors, sizes, opacity)
- `useCommunities` — Louvain community detection
- `useHighlights` — node/edge highlight state

---

## Ingest pipeline

Pure TypeScript pipeline that parses source code into a knowledge graph using [web-tree-sitter](https://github.com/nicolo-ribaudo/tree-sitter-wasm-prebuilt). No React, no browser APIs — works in Node.js, workers, or the browser.

### Peer dependency

The pipeline requires `web-tree-sitter` at runtime:

```bash
npm install web-tree-sitter
```

### Browser setup

WASM grammar files must be served as static assets. Copy them to your app's public directory:

```bash
# All languages (~25 MB)
npx opentrace-copy-wasm public/

# Only the languages you need
npx opentrace-copy-wasm --languages python,typescript,go public/

# Just the runtime (if you load grammars separately)
npx opentrace-copy-wasm --runtime-only public/
```

Add this to `package.json` to keep them in sync:

```json
{
  "scripts": {
    "postinstall": "opentrace-copy-wasm public/"
  }
}
```

### Running the pipeline

```ts
import { Parser, Language } from 'web-tree-sitter';
import {
  runPipeline,
  initParsers,
  collectPipeline,
  type RepoTree,
  type PipelineEvent,
} from '@opentrace/components/pipeline';

// 1. Initialize tree-sitter parsers
await Parser.init({ locateFile: (file) => `/${file}` });

const pyParser = new Parser();
pyParser.setLanguage(await Language.load('/tree-sitter-python.wasm'));

initParsers(new Map([['python', pyParser]]));

// 2. Build a RepoTree (your files)
const repo: RepoTree = {
  owner: 'myorg',
  repo: 'myproject',
  ref: 'main',
  files: [
    { path: 'app.py', content: 'def hello():\n    print("hi")\n' },
    { path: 'utils.py', content: 'def helper():\n    pass\n' },
  ],
};

// 3. Run the pipeline (streaming)
for (const event of runPipeline({ repo }, { cancelled: false })) {
  if (event.nodes) {
    console.log(`${event.phase}: ${event.nodes.length} nodes`);
  }
}

// Or collect everything at once
const { nodes, relationships } = collectPipeline(
  { repo },
  { cancelled: false },
);
```

### Pipeline stages

The pipeline is a chain of synchronous generators. Each stage yields `PipelineEvent` objects:

```
runPipeline()
  saving(inner, store)              <- persists nodes/rels to the store
    wrapWithSummaries(inner)        <- adds summary property to every node
      corePipeline()                <- produces events via:
        yield* scanning()           <- repo structure (files, dirs, packages)
        yield* processing()         <- symbol extraction (classes, functions)
        yield* resolving()          <- call resolution (CALLS relationships)
```

**Scanning** — builds the structural graph: Repository, Directory, File, Package nodes + DEFINED_IN, DEPENDS_ON relationships. Parses dependency manifests (package.json, go.mod, requirements.txt, pyproject.toml, Cargo.toml).

**Processing** — parses each file with tree-sitter, extracts Class/Function nodes, analyzes imports, and builds registries for call resolution.

**Resolving** — resolves function calls using a 7-strategy priority resolver (self/this, Go receiver, ClassName.method, import-based, constructor, intra-file, cross-file).

**Summarizing** — generates one-sentence summaries for every node using identifier analysis and template patterns. No ML required.

### Using the in-memory store

```ts
import {
  runPipeline,
  MemoryStore,
  type RepoTree,
} from '@opentrace/components/pipeline';

const store = new MemoryStore();
const repo: RepoTree = { /* ... */ };

for (const event of runPipeline({ repo }, { cancelled: false }, store)) {
  // events flow through
}

// Query the store
console.log(`${store.nodes.size} nodes, ${store.relationships.size} relationships`);

const classes = [...store.nodes.values()].filter(n => n.type === 'Class');
const calls = [...store.relationships.values()].filter(r => r.type === 'CALLS');
```

### Supported languages

| Language | Extractor | Import analysis | Call resolution |
|---|---|---|---|
| Python | Bespoke | Yes | Yes |
| TypeScript/TSX | Bespoke | Yes | Yes |
| JavaScript/JSX | Bespoke (shared with TS) | Yes | Yes |
| Go | Bespoke | Yes (with module path) | Yes |
| Rust | Generic | Yes | No |
| Ruby | Generic | Yes | No |
| Java | Generic | No | No |
| Kotlin | Generic | No | No |
| C# | Generic | No | No |
| C | Generic | No | No |
| C++ | Generic | No | No |
| Swift | Generic | No | No |

### Node.js WASM helpers

For Node.js scripts, tests, or CLI tools, use the WASM path helpers to locate grammar files without hardcoding paths:

```ts
import { readFile } from 'node:fs/promises';
import { Parser, Language } from 'web-tree-sitter';
import { getWasmPath, getWasmDir } from '@opentrace/components/pipeline/wasm';

// Initialize the runtime
const runtimeBuf = await readFile(getWasmPath('runtime'));
await Parser.init({
  locateFile: () => getWasmPath('runtime'),
  wasmBinary: runtimeBuf,
});

// Load a specific grammar
const parser = new Parser();
const lang = await Language.load(await readFile(getWasmPath('python')));
parser.setLanguage(lang);

// Or get the directory for bulk operations
const wasmDir = getWasmDir(); // absolute path to .wasm files
```

> **Note:** `@opentrace/components/pipeline/wasm` uses `node:fs` and `node:path` internally. Import it only in Node.js contexts — not in browser bundles.

### Using individual parsers

The extractors, import analyzer, and manifest parser are all exported individually:

```ts
import {
  extractPython,
  extractTypeScript,
  extractGo,
  extractGeneric,
  analyzeImports,
  parseManifest,
  isManifestFile,
  resolveCalls,
  summarizeFromMetadata,
} from '@opentrace/components/pipeline';
```

---

## Graph node types

The pipeline produces these node types:

| Type | Description | ID format |
|---|---|---|
| Repository | Source code repository | `owner/repo` |
| Directory | Directory in the repo | `owner/repo/path` |
| File | Source file | `owner/repo/path/file` |
| Class | Class, struct, interface, enum | `fileId::ClassName` |
| Function | Function or method | `fileId::funcName` or `classId::methodName` |
| Package | External dependency | `pkg:registry:name` |

## Relationship types

| Type | Description |
|---|---|
| DEFINED_IN | Child is defined in parent (File in Dir, Class in File, etc.) |
| CALLS | Function/method calls another function/method |
| IMPORTS | File imports another file or package |
| DEPENDS_ON | Repository depends on a package |

---

## Development

```bash
# Build the library
npm run build

# Run tests
npm test

# Format
npm run fmt

# Lint
npm run lint
```

## License

Apache 2.0 — see [LICENSE](../LICENSE).
