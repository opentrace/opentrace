# Wikiv3 Demo — Follow-Along Walkthrough

Hands-on tour of the wikiv3 + graph features added on top of origin/main. Run the commands yourself on your own machine and watch what the graph + UI do at each step.

**Time:** ~25 minutes if you do every section. ~10 if you only do the headline sections (1, 3, 4).
**Cost:** ~$0.50 total in LLM API calls. Each section's cost is called out so you can stop early.

---

## Prerequisites

- **`opentraceai` installed from this branch's source** (not PyPI — wikiv3 isn't published yet, and some features here rely on unreleased fixes):
  ```bash
  # From the opentrace repo root:
  uv tool install --force ./agent
  opentraceai --version    # verify it's on your path
  ```
  If you already have `opentraceai` installed via `uv tool install opentraceai` from PyPI, the `--force ./agent` form replaces it with the local-source version. Switch back to PyPI later with `uv tool install --force opentraceai`.
- An LLM API key in your environment. Anthropic is the default and the one this script's outputs are sized against:
  ```bash
  export ANTHROPIC_API_KEY=sk-ant-...
  ```
  Gemini / OpenAI / Kimi / Ollama all work too — set the matching env var. See `docs/reference/wiki-providers.md`.
- Two terminals open. We'll call them T1 (main demo) and T2 (cross-project section).
- A browser tab ready for the UI part later.

---

## Quick setup

Copy a small chunk of opentrace's own source + docs into a throwaway sandbox. Cheap, deterministic, gives you both real code and real docs that share concepts (so cross-domain bridges actually have something to find).

```bash
# In T1, from the opentrace repo root:
pkill -f 'opentraceai (serve|watch|mcp)' 2>/dev/null
rm -rf /tmp/ot-demo /tmp/ot-demo-b ~/.opentrace/vaults/opentrace-demo

mkdir -p /tmp/ot-demo/{code,papers}

# 10 code files — the wikiv3 command surface
for f in main serve mcp_server vault_cmd analyze_cmd cluster_cmd export_graph watch hook impact; do
  cp ./agent/src/opentrace_agent/cli/$f.py /tmp/ot-demo/code/
done

# 10 docs that overlap conceptually with those commands
for f in \
  docs/index.md \
  docs/getting-started/install-cli.md \
  docs/getting-started/indexing.md \
  docs/getting-started/wiki.md \
  docs/reference/vault-commands.md \
  docs/reference/cli-flags.md \
  docs/reference/wiki-providers.md \
  docs/reference/graph-tools.md \
  docs/architecture/overview.md \
  docs/architecture/ontology.md; do
  cp $f /tmp/ot-demo/papers/
done

cd /tmp/ot-demo
ls papers/        # 10 markdown docs
ls code/          # 10 Python files
```

Picked deliberately: the docs describe the same commands the code implements, so the doc-derived entities share names with code symbols. That overlap is what makes the `MENTIONS` page↔entity bridges and the cross-cutting communities in section 3 plentiful and obvious. (Code files no longer produce entities themselves — extraction is docs-only — but the shared vocabulary still ties the layers together.) If you want a bigger demo afterward, swap the explicit lists for `cp -r ./agent/src/opentrace_agent/cli /tmp/ot-demo/code/` + `find ./docs -name "*.md" -exec cp {} /tmp/ot-demo/papers/ \;` (~50 files, ~8-10 min, ~$0.50).

If you'd rather use a different corpus, swap in any small code repo + any folder of markdown/PDF/HTML docs. The expected outputs below will look different, but the *shape* will match.

---

## Section 1: Unified index (2-3 min · ~$0.18)

One command, two modes:

- **Plain `index`** — code-only. tree-sitter parses every supported source file → `File` / `Class` / `Function` / `Module` nodes + `CALLS` / `IMPORTS` edges. **No LLM, no cost.**
- **`index --wiki [VAULT_NAME]`** — adds a doc-ingestion pass on top of the code walk. For each doc file (md/pdf/html/txt/docx), a **single LLM call** produces all three of:
  1. a **file-summary** Page (1:1 with the doc),
  2. the **knowledge-graph entities** — `Idea` / `Service` / `Module` / `Paper` / `Person` / `Event` nodes (each with a one-line `description`) + `DERIVED_FROM` edges back to their `Source`, plus entity↔entity `SEMANTIC_EDGE`s,
  3. that doc's **concept inventory** — each concept tagged with `topic` / `subject` / `gloss`.

  Then a cheap deterministic merge collapses duplicate entities, the concept mentions are clustered into cross-document **concept pages**, and the whole result is mirrored into the graph beside the vault.

> **Entity extraction is docs-only now, and folded into the wiki pass.** Code files never hit the LLM — their structural layer (`File`/`Class`/`Function` + `CALLS`/`IMPORTS`) already comes from tree-sitter, so re-extracting them with an LLM was pure cost. The old standalone `--extract-entities` and `--build-pages` flags are both gone; everything routes through `--wiki`, where one per-doc call does summary + entities + concepts at once.

> The vault name is the optional second positional. Omit it and it defaults to the path basename. A bare vault-name positional implies `--wiki`, so `index ./ opentrace-demo` works too. Add `--global` to compile into `~/.opentrace/vaults/` instead of the project.

**Cost + speed knobs (new):**

- **Cheap tier for the per-doc pass.** Entity extraction + file summaries run on a cheap model (Anthropic → Haiku, Gemini → Flash, OpenAI → gpt-4.1-mini); only cross-document concept synthesis uses the flagship. Override per role: `OT_EXTRACTION_MODEL` / `OT_WIKI_SUMMARY_MODEL` (cheap tier), `OT_WIKI_MODEL` (flagship).
- **Parallelism.** The per-doc loop runs `OT_EXTRACTION_CONCURRENCY` docs at once (default 8), behind an adaptive limiter that ratchets concurrency *down* on 429/529 (never back up) and a `Retry-After`-aware retry loop (`OT_LLM_MAX_RETRIES`).
- **Content-sha cache.** Each doc's extraction is cached at `.opentrace/entity_cache/<sha>.json`, keyed on raw bytes and checked *before* markitdown — a re-run skips both file conversion and the LLM for unchanged docs. Opt out with `OT_EXTRACTION_NO_CACHE=1`.

```bash
# T1, in /tmp/ot-demo
opentraceai index --wiki ./ opentrace-demo
```

### What you'll see

```
Opening staging database at /tmp/ot-demo/.opentrace/index.db.staging ...
Indexing /tmp/ot-demo ...
  Scanning directory tree
  Scanned ~25 nodes, 10 parseable files
  Processing 10 files
  Extracted N classes, M functions, ...
  --wiki: ingesting 10 doc(s) into local vault 'opentrace-demo' ...
    via anthropic (~$0.18 estimated)
    wiki: Acquired 10 new, skipped 0 duplicate
    wiki: Normalizing 10 source(s)
    wiki: Summarising 10 source(s)
    wiki: [10/10] Summarised file-summary/<file>
    wiki: Extracted X entities, Y relationships from 10 doc(s) (Z before merge)
    wiki: Resolving concepts from K mention(s)
    wiki: Plan: P create, E extend (from C concept(s))
    wiki: Executing ...
    wiki: Mirrored vault to graph — N nodes, M rels, X entities
    wiki: Compile complete — 10 file summary page(s), P concept page(s)
  Autoprune: no orphans found.
Done in ~120s.
```

### What to notice

- **Code walk first, no LLM.** The `Scanning` / `Processing` / `Extracted N classes` lines are tree-sitter only. The LLM fires only once `--wiki` reaches the doc pass.
- **Pre-flight cost estimate** before any LLM call (`via anthropic (~$X estimated)`).
- **One call per doc does three jobs** — summary + entities + concept inventory. There's no separate entity-extraction phase in the output anymore.
- **Entity merge** runs after the per-doc loop: `Extracted X entities … (Z before merge)` shows duplicates collapsed by `(type, canonical name)` — so "Autoprune" named in `overview.md`, `wiki.md`, and `cli-flags.md` lands as one node with a `DERIVED_FROM` edge to each source.
- **Concept clustering, not a planner.** `Resolving concepts from K mention(s)` → `Plan: P create, E extend`. Concept pages are clustered from the per-doc mentions by `(topic, subject)` — synonyms merge into one page citing every source, polysemy splits into distinct pages — rather than one planner call enumerating everything (which used to satisfice and miss central multi-doc concepts).
- **`Done in N.Ns`** includes wiki + autoprune time.

```bash
opentraceai stats
```

You'll see counts for all three layers: `Repository / File / Class / Function / Module` (code, tree-sitter, always there) plus `Source / Vault / Page / Idea / Service / Person / Event` (the doc pass).

---

## Section 2: The vault on disk (3 min · $0)

Everything compiled lives as plain markdown on disk; the DB is just a derived mirror.

```bash
find .opentrace/vaults/opentrace-demo/pages -type f | sort
```

### What you'll see

```
.opentrace/vaults/opentrace-demo/pages/concept/<some-slug>.md
.opentrace/vaults/opentrace-demo/pages/concept/<another-slug>.md
.opentrace/vaults/opentrace-demo/pages/file-summary/<file-1>.md
.opentrace/vaults/opentrace-demo/pages/file-summary/<file-2>.md
...
```

Two folders: `concept/` and `file-summary/`. Slugs are `<kind>/<base>` so a concept and a file-summary can share titles without collision. Pick a concept page and read it:

```bash
cat .opentrace/vaults/opentrace-demo/pages/concept/*.md | head -60
```

You'll see `[[wiki-link]]` syntax linking to other pages. Obsidian-compatible — the `|` alias divider works too (`[[Slug|Display]]`).

```bash
cat .opentrace/vaults/opentrace-demo/.vault.json | python3 -m json.tool | head -30
```

`.vault.json` is the authoritative record — page list, source SHAs (used for re-compile dedup), `last_compiled_at`. The graph mirror is rebuilt from this file by `vault attach`.

---

## Section 3: Cluster + analyze (5 min · $0) — the headline

Two separate commands with different jobs:

**`cluster`** — *mutates the graph*. Runs Leiden (Louvain fallback), groups densely-connected nodes into clusters, and writes the result back as real `Community` graph nodes + `MEMBER_OF` edges so every other node knows which cluster it belongs to. Idempotent: re-running clears the old Communities first. Run this once after a big indexing pass; re-run after major changes.

**`analyze`** — *read-only print job*. Reads the current graph (Communities included if `cluster` has run) and prints: god nodes, cross-community bridges, cross-domain bridges, cross-cutting communities. No writes. Run whenever you want a snapshot of structural insights. Sections 2-4 of its output require `cluster` to have run first — without communities they just stay empty.

Both are deterministic, no LLM.

```bash
opentraceai cluster
opentraceai analyze
```

### Concept cheat-sheet

- **Community** — a tightly-linked group of nodes detected by Leiden/Louvain. Persists as a real `Community` graph node with its own properties (size, dominant type, cohesion score); every other node has a `MEMBER_OF` edge to exactly one Community. You can query Communities like any node, traverse from them to their members, etc. The folder names in the obsidian export (`module-cluster-48-nodes/`) come from these.
- **God node** — *not a node type, never persisted*. Computed inline every time someone calls `analyze` (or hits `/api/highlights/gods`, or invokes the MCP tool). The whole definition is "SELECT every node ORDER BY degree DESC LIMIT N" where degree = incoming + outgoing edges. Any existing node type can rank — File, Function, Page, or even a Community itself. Re-running after a re-index changes the ranking because degrees changed; re-running on the same graph gives the same answer. Useful for spotting the hubs the rest of the graph orbits — touch them and you affect everything.
- **Cross-community bridge** — an edge whose source and target sit in *different* communities. The structural seams holding otherwise-separate clusters together.
- **Cross-domain bridge** *(new in wikiv3)* — an edge crossing one of the three ontological layers (code / entity / page). Since extraction is docs-only, the producers are `DERIVED_FROM` (entity → `Source`, i.e. entity → page layer) and `MENTIONS` (page → entity).
- **Cross-cutting community** *(new in wikiv3)* — a community whose members span ≥2 domains. Signal that a concept legitimately exists across code, docs, and entities at once.

### What you'll see in `analyze`

Four sections, in order. Examples are roughly what you'll get on the opentrace-itself sandbox — your exact lines will differ.

**1. God nodes** — a mix of `File`, `Community`, and `Page` types in one ranking:
```
God nodes (top 10 by degree):
    48  Community       Module cluster (48 nodes)
    36  File            main.py
    32  Page        Indexing
    29  Community       Function cluster (29 nodes)
    ...
```
Pages can be god nodes now because they carry a lot of MENTIONS + CITES edges.

**2. Cross-community bridges:**
```
Indexing [Module cluster (48 nodes)] --MENTIONS--> index_command [Module cluster (27 nodes)]
```
The `MENTIONS` edge is new — emitted when a wiki page body name-matches an extracted entity.

**3. Cross-domain bridges (code ↔ entity ↔ page):**
```
AppConfig (entity/Module) --DERIVED_FROM--> install-cli.md (page/Source)
```
The LLM pulled `AppConfig` out of a doc body; the entity links back to the `Source` it derived from — an entity → page bridge. This is the section that didn't exist before wikiv3.

**4. Cross-cutting communities (span ≥2 domains):**
```
Module cluster (48 nodes) — entity+page (48 members: {'entity': 39, 'page': 9})
```
Communities whose members aren't purely code, purely doc, or purely entity.

```bash
opentraceai analyze --json | jq '.cross_domain_bridges[:3]'
```

Same data as JSON — for piping into other tools or eyeballing the schema.

---

## Section 4: UI walkthrough (5 min · $0)

Start the REST server + the UI dev server, then drive everything through the browser.

```bash
# T1 still in /tmp/ot-demo
opentraceai serve >/tmp/serve.log 2>&1 &
sleep 2 && curl -sS http://localhost:8787/api/stats | head -c 200
```

You should see node counts come back as JSON. If not, check `/tmp/serve.log`.

In another terminal:

```bash
# From the opentrace repo root
cd ui && npm run dev
```

Open `http://localhost:5173?server=http://localhost:8787` — the `?server=` query param tells the UI to use server mode (read-only against `opentraceai serve`).

### What to click through

- **Graph rendered** — toolbar shows the same node/edge counts as `stats`. Knowledge Highlights panel on the right has god/bridges/questions tabs (the data from `analyze`, served via `/api/highlights/*`).
- **Click a god node** in the highlights panel — side panel populates with details via `/api/nodes/{id}`.
- **Search "index"** in the toolbar — hits `/api/retrieval/search` (FTS via Porter stemmer in the store).
- **Bottom-left: Vaults button** (only shows in server mode). Click it.

The **Vaults manager** opens (a modal — management only, not a reader):
- **Project / Global tabs** — Project = locals + globals attached here. Global = every global on the machine with attach state.
- **Scope-aware action icons per row** — trash, detach, attach `+` only show when they make sense for that scope+attached-state combo.
- **`+ Compile files`** — drop docs to compile a new vault.

**Reading happens in the graph, not the manager.** A compiled vault mirrors into the graph as `Vault` / `Page` / `CorpusDoc` nodes. Close the manager and:
- **Click a `Page` node** — its markdown renders in the Details side panel, exactly the way a `File` node shows its source. The page is the node.
- **Click a `CorpusDoc` node** — the raw source document (markitdown-normalised) renders in Details too, the same way. Reading a doc is just landing on its node.
- **Follow a `[[wiki-link]]`** in a concept page — it selects the linked page's node, so an internal link is a graph hop (the graph animates to it).

Now the AI Assistant panel:
- Ask: **"What's in the opentrace-demo vault?"**
- The agent will call `list_vaults` → `list_vault_pages` → `read_vault_page` LangChain tools (defined in `chat/vaultTools.ts`). Same primitives the MCP server exposes. You'll see the page summaries quoted in its answer.

---

## Section 5: Vault portability — global + cross-project attach (4 min · $0)

`vault promote` moves the on-disk directory from `<project>/.opentrace/vaults/` to `~/.opentrace/vaults/` (the global root, overridable via `$OT_VAULT_ROOT`), and auto-attaches against the current project so the graph mirror's `scope` property updates immediately.

```bash
# T1
opentraceai vault promote opentrace-demo
```

### What you'll see

```
Moved vault 'opentrace-demo': local → global
  Re-attached to this project's graph: N nodes, M rels.
  ⚠ Other projects with 'opentrace-demo' attached still see scope='local'. ...
```

The "Re-attached to this project's graph" line is the auto-attach — used to require running `vault attach` manually after every promote. The corpus bodies (markitdown-rendered source content) also moved to `~/.opentrace/corpus/<sha>.md` — scope-aware corpus routing.

```bash
ls ~/.opentrace/vaults/opentrace-demo/
ls ~/.opentrace/corpus/ | head
```

`vault attach` mirrors a disk vault into a graph. Zero LLM cost — reads `.vault.json` + page bodies + corpus files, writes Vault / Page / Source nodes plus CONTAINS / CITES / LINKS_TO edges, and copies any global-scope corpus files into the attaching project's corpus dir so `Source.corpus_path` resolves locally.

```bash
# T2: completely different project
mkdir -p /tmp/ot-demo-b && cd /tmp/ot-demo-b
opentraceai index .                               # fresh empty graph (Repository node only)
opentraceai vault list                            # opentrace-demo: not attached
opentraceai vault attach opentrace-demo
opentraceai vault list                            # opentrace-demo: attached
opentraceai query "MATCH (n:Node) WHERE n.type = 'Page' RETURN n.id LIMIT 5"
```

You'll get 5 Page IDs from the same compiled vault, now queryable from a totally separate graph. Check `/tmp/ot-demo-b/.opentrace/corpus/` — it'll have the source bodies that the attach copied over.

---

## Section 6: Autoprune cascade + refresh (4 min · ~$0.10)

Autoprune runs after every `index --wiki`. It compares the walked-source set against what's already in the graph and removes anything orphan, scope-limited to the walked path or vault.

```bash
# T1
cd /tmp/ot-demo
ls papers/ | head -5
rm papers/<pick-any-md-file>     # use one of the listed names
opentraceai index --wiki ./ opentrace-demo
```

### What you'll see

```
Autoprune: -1 sources, -0 entities, -1 file_summary pages, -0 concept pages, N stale-marked, -1 corpus files
```

The cascade walks two hops:
- Source removed → its 1:1 `file_summary` page is deleted (graph + disk + corpus).
- Concept pages that cite the deleted file-summary get inspected. If they still have other citations → `stale_since` timestamp stamped. If they have 0 citations left → deleted entirely.

Confirm the stale pages exist in the graph:

```bash
opentraceai query "MATCH (n:Node) WHERE n.type = 'Page' AND n.properties CONTAINS 'stale_since' RETURN n.id"
```

`refresh-stale-pages` re-runs the wiki Execute step against the page's remaining citations and clears the `stale_since` stamp on success. Cost = ~1 LLM call per stale page.

```bash
opentraceai vault refresh-stale-pages opentrace-demo
opentraceai query "MATCH (n:Node) WHERE n.type = 'Page' AND n.properties CONTAINS 'stale_since' RETURN n.id"
```

Second query should return 0 rows.

---

## Section 7: URL + single-file ingestion (2 min · ~$0.05)

`index --wiki` accepts a URL or single file in addition to a directory. Both skip the `DirectoryWalker` entirely (so no fake Repository/File nodes for one URL) and go through a single-source pipeline that builds one `SourceInput` and feeds it to the unified doc pass — one LLM call → file-summary page + entities. A single-file/URL input *requires* `--wiki` (there's no code to walk, so plain `index` rejects it).

```bash
opentraceai index --wiki https://arxiv.org/abs/1706.03762
```

### What you'll see

```
Fetching https://arxiv.org/pdf/1706.03762.pdf ...
Opening staging database at .../index.db.staging ...
  --wiki: ingesting 1 doc into local vault '1706-03762' ...
    via anthropic (~$0.03 estimated)
    wiki: Acquired 1 new, skipped 0 duplicate
    wiki: Extracted N entities, M relationships from 1 doc(s)
    wiki: Compile complete — 1 file summary page(s), 0 concept page(s)
Done in ~30s.
```

`sources/markdown/fetchers.py` rewrites arXiv abstract URLs to the PDF before markitdown. Source node ends up with `source_uri` = the original `/abs/` URL (the rewritten PDF URL is only used for markitdown's fetch).

```bash
opentraceai query "MATCH (n:Node) WHERE n.type = 'Source' AND n.properties CONTAINS 'arxiv' RETURN n.name, n.properties LIMIT 1"
```

Single-file works the same way:

```bash
opentraceai index --wiki ./papers/<some-file>.md
```

---

## Section 8: Provider override (1 min · ~$0.02)

LLM backend autodetect order is `ANTHROPIC_API_KEY` → `GEMINI_API_KEY`/`GOOGLE_API_KEY` → `MOONSHOT_API_KEY` → `OPENAI_API_KEY` → local (Ollama via `OT_LOCAL_LLM_URL`). `OT_LLM_PROVIDER` pins a specific backend without needing to unset other keys.

```bash
# Skip if you don't have a second provider key — this is just to show the override exists.
export GEMINI_API_KEY=<your-gemini-key>
export OT_LLM_PROVIDER=gemini
opentraceai index --wiki ./papers/<other-file>.md 2>&1 | grep "via "
# → via gemini

unset OT_LLM_PROVIDER
opentraceai index --wiki ./papers/<yet-another>.md 2>&1 | grep "via "
# → via anthropic (precedence wins again)
```

> The cheap-tier split applies here too: extraction + per-doc summaries run on the provider's cheap model (Haiku / Flash / gpt-4.1-mini), while concept synthesis uses its flagship. `OT_LLM_PROVIDER` picks the backend; the per-role model resolution picks the tier within it.

---

## Section 9: Exports (3 min · $0)

Three deterministic exporters, no LLM:

```bash
mkdir -p /tmp/ot-exports
cd /tmp/ot-demo
opentraceai export-graph obsidian -o /tmp/ot-exports/obsidian
```

`export-graph obsidian` synthesises a markdown vault from the graph: one `.md` per node, folder per community, `[[wikilinks]]` for edges.

Open `/tmp/ot-exports/obsidian` in Obsidian itself — graph view works, wiki-links navigate, community structure visible as folders.

```bash
opentraceai export-graph report -o /tmp/ot-exports/report
cat /tmp/ot-exports/report/index.md | head -20
ls /tmp/ot-exports/report/communities/ | head
```

`export-graph report` writes `index.md` + per-community + per-god-node articles. Designed for an AI agent to crawl when MCP isn't available.

```bash
opentraceai export-graph graphml -o /tmp/ot-exports/graph.graphml
```

`export-graph graphml` writes a single `.graphml` file (Communities + Hyperedges + edges + basic attrs). Loads in Gephi / yEd / Cytoscape if you want big-graph visualisation.

---

## Section 10: MCP (skip if no MCP client to hand) — 2 min · $0

`opentraceai mcp` starts a stdio JSON-RPC MCP server exposing the same retrieval primitives the REST API has, plus the cross-cutting helpers. Any compliant MCP client (Claude Code, Cursor, OpenCode) can register it.

You can smoke-test the protocol without a real client:

```bash
(echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'; \
 echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; \
 echo '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; \
 sleep 1) | opentraceai mcp 2>/dev/null | head -c 2000
```

Look for a `serverInfo` object and a `tools` array. Available tools:

- Original: `search_graph`, `list_nodes`, `traverse`, `get_node`, `query`
- New in wikiv3: `list_vaults`, `list_vault_pages`, `read_vault_page`, `find_cross_cutting_communities`, `provenance`, `find_orphans`, `grep`, `get_god_nodes`

  (`find_pages_mentioning` / `find_entities_mentioned_by` were removed 2026-08-04 with the LLM-extracted entity layer they traversed — `grep` answers "which documents discuss X" instead.)

For a real demo, configure your MCP client to point at `opentraceai mcp` and ask it a question like "what concepts span multiple sources in opentrace-demo?" — it should pick `find_cross_cutting_communities` unprompted.

---

## Cleanup

```bash
pkill -f 'opentraceai (serve|watch|mcp)' 2>/dev/null
pkill -f 'npm run dev' 2>/dev/null
rm -rf /tmp/ot-demo /tmp/ot-demo-b /tmp/ot-exports ~/.opentrace/vaults/opentrace-demo
# Optional: ~/.opentrace/corpus/ may still have global-scope source bodies; remove if you want a clean slate
rm -rf ~/.opentrace/corpus/
```

---

## Highlights-only path (if you have ~10 minutes)

Run sections 1, 3, 4. That gives you the unified index, cross-domain bridges, and the UI walkthrough — the headline beats. Skip everything else.
