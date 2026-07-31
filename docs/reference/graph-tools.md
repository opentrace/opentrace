# Graph Tools

The OpenTrace knowledge graph is queryable through three transports: MCP (Model Context Protocol) for agents, REST for the UI, and direct Python imports under `opentrace_agent.retrieval`. All three expose the same underlying primitives — read-only, scoped, typed.

## Retrieval primitives

| Primitive | What it returns | Use it for |
|---|---|---|
| `search` | Ranked FTS hits with snippets + vault/recency/confidence | "Find anything called X" |
| `overview` | <500-token corpus orientation: counts + top concepts + recently-updated | Agent session priming |
| `find_path` | Shortest path between two nodes (Python BFS, no networkx dep) | "How are these two connected?" |
| `find_orphans` | Nodes of a type with no edges of a given type | "Functions never called" |
| `find_via_relationship_to_type` | All `(A) -[edge]-> (B)` pairs for given types | "All Files that DEFINE Classes" |
| `count_by` | Global or descendants-of-parent counts | "How many Functions in this Service?" |
| `provenance` | Trust chain — code (commit_sha + line range), wiki (CITES chain), or derived (DERIVED_FROM KnowledgeDoc) | "Where did this come from?" |
| `grep` | Regex match via ripgrep over a Repository or Vault scope | "Find this exact string in source" |
| `list_communities` | Detected Community nodes with cohesion + member counts | After running `cluster` |
| `god_nodes` | Top-degree nodes (centrality hubs) | "What's connected to everything?" |
| `cross_community_bridges` | Edges spanning different communities | "Where do two clusters touch?" |
| `cross_domain_bridges` | Edges spanning code / entity / page domains | "What connects code and docs?" |
| `find_communities_spanning_domains` | Communities whose members span ≥N domains | Cross-cutting topics |
| `find_pages_mentioning` | Pages and KnowledgeDocs that MENTION a given entity (typed hits) | "Pages and docs discussing this concept" |
| `find_entities_mentioned_by` | Entities a Page MENTIONS | "What does this page reference?" |

## MCP tools

The MCP server (`opentraceai mcp`) exposes each primitive as a tool. The Claude Code plugin auto-discovers them.

```
search_graph                            # ranked FTS over names + summary
get_node                                # full node by id + immediate neighbors
list_nodes                              # paginated by type
traverse_graph                          # BFS with direction, max depth, rel-type filter
find_path                               # shortest path between two nodes
find_orphans                            # missing-edge detection
find_via_relationship_to_type           # typed (A)-[edge]->(B) pairs
count_by                                # counts, optionally scoped to a parent
overview                                # session-start orientation
provenance                              # trust chain for a node
grep                                    # ripgrep over Repository / Vault scope
get_communities                         # listed clusters
get_god_nodes                           # centrality hubs
get_bridges                             # cross-community edges
load_source                             # a node's underlying content — code from the
                                        #  repo checkout, KnowledgeDoc bodies from the
                                        #  corpus, Page bodies from the vault
get_stats                               # node + edge counts by type
```

Every tool produces a JSON-serialisable response truncated to 4000 chars by default — agents see the same shape across transports.

## REST endpoints

`opentraceai serve` exposes the same primitives as HTTP:

```
GET  /api/health
GET  /api/stats
GET  /api/metadata
GET  /api/graph
GET  /api/nodes/search?query=...
GET  /api/nodes/list?type=...
GET  /api/nodes/{id}
POST /api/traverse
POST /api/retrieval/search
POST /api/retrieval/overview
POST /api/retrieval/find_path
POST /api/retrieval/find_orphans
POST /api/retrieval/find_via_relationship_to_type
POST /api/retrieval/count_by
POST /api/retrieval/provenance
POST /api/retrieval/grep
GET  /api/communities
GET  /api/highlights/gods
GET  /api/highlights/bridges
GET  /api/highlights/questions

# Vaults
GET    /api/vaults?view=project|global
GET    /api/vaults/{vault}/pages?scope=local|global
GET    /api/vaults/{vault}/pages/{slug:path}?scope=local|global
POST   /api/vaults/{vault}/compile         # multipart: files, api_key, provider, model?, base_url?, scope?
POST   /api/vaults/{vault}/attach          # mirror a global disk vault into this project's graph
POST   /api/vaults/{vault}/detach          # remove a vault's mirror (disk vault stays)
DELETE /api/vaults/{vault}?scope=local|global
```

`view=project` (default) returns local vaults from cwd plus globals already attached to this project's graph; `view=global` lists every global on the machine with an `attached` flag. The `?scope=` query param disambiguates when a name exists in both scopes — when omitted, the server resolves local-first.

`POST /compile` is **corpus-only**, matching the CLI default: it indexes the uploaded documents (labels, entity graph, doc links, verbatim bodies) and does not synthesize concept pages. Page synthesis is CLI-only today, via `index --wiki --wiki-concept-pages`.

The UI's `ServerGraphStore` consumes these. See [Browser](../getting-started/install-browser.md) for setup.

## Python API

```python
from opentrace_agent.store import GraphStore
from opentrace_agent.retrieval import (
    search,
    overview,
    find_path,
    provenance,
    grep,
    god_nodes,
    cross_community_bridges,
    cross_domain_bridges,
    find_communities_spanning_domains,
    find_pages_mentioning,
    find_entities_mentioned_by,
)

with GraphStore(".opentrace/index.db") as store:
    hits = search(store, "authentication", limit=10)
    path = find_path(store, "myrepo/auth.py::AuthMiddleware", "myrepo/login.py::login")
    bridges = cross_domain_bridges(store, limit=20)
```

All retrieval primitives are read-only; no module under `opentrace_agent.retrieval` writes to the store.

## Node types

The graph contains three layers plus some auxiliary types.

### Code layer

From `opentraceai index` (always produced):

| Type | What it is |
|---|---|
| `Repository` | A code repository — carries `local_path` for local indexes |
| `Directory` | A directory in a repo |
| `File` | A source file (tree-sitter-parsed) |
| `Class` | A class / struct / interface / record |
| `Function` | A function or method |
| `Variable` | A field / parameter / module-level variable |
| `Dependency` | An external package from a manifest (`package.json`, `pyproject.toml`, etc.) |

### Entity layer

From `index --wiki` — flat LLM-extracted entities with no body:

| Type | Examples |
|---|---|
| `Idea` | "Authentication", "Diffusion Models", "Rate Limiting" — abstract concepts |
| `Service` | "auth-service", "billing-api" |
| `Module` | "TokenBucket", "AuthMiddleware" |
| `Paper` | "Attention Is All You Need", arXiv IDs |
| `Person` | "Karen Chen", "Vaswani et al." |
| `Event` | "the 2024 release", "the security incident" |

### Concept layer

From `index --wiki` — the indexed documents themselves, bodies verbatim in the corpus:

| Type | What it is |
|---|---|
| `KnowledgeVault` | A named vault (one per disk vault dir). Carries `scope` (local / global) + `mirror_compiled_at` + `spawned_from` (repo id, when built by `index --wiki` over a repo) |
| `KnowledgeConcept` | A concept page (`kind="concept"` — the only kind), a multi-source synthesized narrative. **Only produced under `index --wiki --wiki-concept-pages`** — a plain `--wiki` run is corpus-only. Body on disk; `confidence` / `confidence_tier` / `stale_since` stamped |
| `KnowledgeDoc` | A raw ingested artifact — sha256-keyed (`corpus::<sha>`), with a navigation label (`title` + `one_line_summary`) for search and browsing. Body in `<project>/.opentrace/corpus/<sha>.md` for local vaults (read it via `load_source`); for globals compiled but not yet attached, it lives at `~/.opentrace/corpus/<sha>.md` and is copied into the project's corpus on `vault attach`. |

### Auxiliary

| Type | What it is |
|---|---|
| `Community` | Cluster detected by `opentraceai cluster` |
| `Hyperedge` | Group relationship of 3+ entities |
| `IndexMetadata` | Per-repo provenance record (commit sha, index version) |

## Edge types

| Edge | Source → Target | Meaning |
|---|---|---|
| `CONTAINS` | Directory → File, Repo → Directory, Vault → Page/KnowledgeDoc | Hierarchy |
| `DEFINES` | File → Class/Function, Class → Function | Symbol definition |
| `CALLS` | Function → Function | Resolved call |
| `IMPORTS` | File → external Package | Resolved import |
| `DEPENDS_ON` | Repo → Dependency | Manifest dependency |
| `DERIVED_FROM` | Idea/Service/... → KnowledgeDoc | Entity provenance (with `transform="llm_extraction"`) |
| `CITES` | Page(concept) → KnowledgeDoc | Direct wiki provenance (one hop, keyed by doc sha). Only with `--wiki-concept-pages` |
| `LINKS_TO` | KnowledgeDoc → KnowledgeDoc | A relative link the doc's author wrote to another doc — parsed mechanically (no LLM) from markdown links, reference definitions, and HTML anchors, resolved against the linking doc's directory. The doc-side analogue of `IMPORTS`. External URLs, bare fragments, and out-of-repo targets are dropped |
| `LINKS_TO` | Page → Page | Wiki-link in a page body (`[[Title]]`). Only with `--wiki-concept-pages` |
| `MENTIONS` | Page/KnowledgeDoc → Idea/Service/... | Page body or doc corpus markdown references an entity name. Deduped against `DERIVED_FROM` — a doc gets no MENTIONS to an entity it was the extraction source of (that's the reverse `DERIVED_FROM` edge). `find_pages_mentioning` unions both |
| `MIRRORS` | KnowledgeDoc → File | The ingested doc's twin in the code tree, stamped during `index --wiki` on a directory for every repo-walked doc (the KnowledgeDoc also gets a repo-relative `path`; the File node is created at link time if the code walk skipped its extension). Docs not from a repo walk (URLs, uploads) have no edge |
| `DOCUMENTS` | Repository → Vault | The vault spawned from this repo — written only by `index --wiki` runs over a repo walk. Attached globals and dropped-file vaults never get it |
| `SEMANTIC_EDGE` | Idea/Service/... → Idea/Service/... | LLM-proposed relationship between entities, with confidence tier |
| `MEMBER_OF_COMMUNITY` | any non-internal node → Community | Cluster membership |
| `PARTICIPATES_IN` | Idea/Service/... → Hyperedge | Group-relationship membership |

## Vault-scoped retrieval

Several primitives accept a `vault_scope` parameter or filter — they restrict results to nodes whose `vault` property matches:

```python
overview(store, vault_scope="research")          # only nodes tagged with the research vault
search(store, "diffusion", vault_scope="papers")  # FTS scoped to one vault
```

`vault` is denormalised onto every `KnowledgeVault` / `KnowledgeConcept` / `KnowledgeDoc` / entity node so the filter is a simple property equality — no graph traversal needed.

## Confidence + provenance

Nodes carry typed confidence where appropriate:

- **Entities** — `confidence` (numeric 0.0–1.0) + `confidence_tier` (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`)
- **Pages** — same fields, plus `stale_since` set by autoprune when a cited doc is removed
- **Edges** — confidence stamped on `SEMANTIC_EDGE` and `CALLS` (resolver confidence)

`provenance(node_id)` walks the right trust chain depending on node type:

- **Code** — reads commit_sha + indexer version from the per-repo `IndexMetadata` node, plus file_path + line_range from the node
- **Wiki** — walks `CITES` from a concept page directly to its KnowledgeDocs
- **Derived** — walks `DERIVED_FROM` from an entity to its KnowledgeDoc

Chain entries for ingested docs have `kind="corpus_doc"` and carry the doc's `path`; when the doc has a `MIRRORS` twin in the code tree, the entry also includes the mirrored `File` id in a `file` field.

## What's not in here

- **Vector / semantic search** — UI-side only (BM25 + transformers.js + RRF in `ui/src/store/search/`). CLI is FTS-only
- **Write tools** — there are none. All retrieval is read-only; graph writes go through `index`, `cluster`, `vault attach`, etc.
- **Custom Cypher** — no escape hatch. Use the typed primitives or extend `retrieval/`
