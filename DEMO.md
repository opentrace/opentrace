# Wikiv3 Demo — Follow-Along Walkthrough

Hands-on tour of the wikiv3 + graph features added on top of origin/main. Run the commands yourself on your own machine and watch what the graph + UI do at each step.

**Time:** ~25 minutes if you do every section. ~10 if you only do the headline sections (1, 3, 4).
**Cost:** ~$0.50 total in LLM API calls. Each section's cost is called out so you can stop early.

> The per-section dollar figures below were sized when one LLM call per doc also produced an entity inventory and a concept-page plan. Both of those layers were removed on 2026-08-04, so a run today costs materially less — one cheap-tier call per document, asking only for a title and a one-line summary, and nothing else. Treat the numbers as ceilings.

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

Picked deliberately: the docs describe the same commands the code implements, and several of them link to each other. That overlap is what makes the code ↔ doc bridges and the cross-cutting communities in section 3 plentiful and obvious — `MIRRORS` twins where a doc is also a walked file, `LINKS_TO` edges from the relative links the doc authors actually wrote, and shared vocabulary in the FTS index. If you want a bigger demo afterward, swap the explicit lists for `cp -r ./agent/src/opentrace_agent/cli /tmp/ot-demo/code/` + `find ./docs -name "*.md" -exec cp {} /tmp/ot-demo/papers/ \;` (~50 files, ~8-10 min, ~$0.50).

If you'd rather use a different corpus, swap in any small code repo + any folder of markdown/PDF/HTML docs. The expected outputs below will look different, but the *shape* will match.

---

## Section 1: Unified index (2-3 min · ~$0.18)

One command, two modes:

- **Plain `index`** — code-only. tree-sitter parses every supported source file → `File` / `Class` / `Function` / `Module` nodes + `CALLS` / `IMPORTS` edges. **No LLM, no cost.**
- **`index --wiki [VAULT_NAME]`** — adds a doc-ingestion pass on top of the code walk. For each doc file (md/pdf/html/txt/docx), a **single cheap LLM call** produces exactly one thing: that document's navigation label (a `title` plus a one-line summary). Nothing else. The body is markitdown-normalised and written **verbatim** to the content-addressed corpus, then mirrored into the graph as a `KnowledgeDoc` with an epistemic `status`, a `MIRRORS` edge to its `File` twin when the code walk saw the same file, and `LINKS_TO` edges for the relative markdown links its author actually wrote (parsed mechanically — no LLM).

> **Nothing is synthesized, and no entities are extracted.** Two layers used to hang off this pass and both are gone. The **LLM-extracted entity layer** (`Idea`/`Service`/`Module`/`Paper`/`Person`/`Event` + `DERIVED_FROM`/`SEMANTIC_EDGE`/`MENTIONS`) was **removed 2026-08-04**. The **concept-page layer** — cross-document synthesized pages, `KnowledgeConcept` nodes, `CITES` edges, `[[wiki-link]]` syntax — lost its synthesis stage **2026-08-03** and everything else **2026-08-04**, because the pages variant measured **88.4% against a 98.6% control (−10.2pp)**, the worst result on record: a synthesized page restates its sources in the model's own voice, stripping their hedges, tense, and attribution, a failure mode a verbatim body structurally cannot have. What replaced it is verbatim `load_source` bodies plus exhaustive corpus `grep`, which answer the same questions. Full record in `agent/src/opentrace_agent/wiki/CLAUDE.md` ("Closed"). The `--extract-entities`, `--build-pages`, and `--wiki-concept-pages` flags are all gone — everything routes through `--wiki`. Code files still never hit the LLM: their structural layer (`File`/`Class`/`Function` + `CALLS`/`IMPORTS`) comes from tree-sitter.

> The vault name is the optional second positional. Omit it and it defaults to the path basename. A bare vault-name positional implies `--wiki`, so `index ./ opentrace-demo` works too. Add `--global` to compile into `~/.opentrace/vaults/` instead of the project.

**Cost + speed knobs (new):**

- **Cheap tier, and only the cheap tier.** The per-doc labelling call runs on a cheap model (Anthropic → Haiku, Gemini → Flash, OpenAI → gpt-4.1-mini) via the `wiki_summary` role; override with `OT_WIKI_SUMMARY_MODEL`. No stage uses the flagship any more — the flagship client existed for cross-document concept synthesis, removed 2026-08-03. An explicit `--model` is honoured here so it isn't silently inert.
- **Parallelism.** The per-doc loop runs `OT_WIKI_CONCURRENCY` docs at once (default 8), behind an adaptive limiter that ratchets concurrency *down* on 429/529 (never back up) and a `Retry-After`-aware retry loop (`OT_LLM_MAX_RETRIES`).
- **Sha-keyed dedup.** Acquire is content-addressed, so re-running over an unchanged corpus reports `Acquired 0 new, skipped N duplicate` and makes no LLM call at all.

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
    via anthropic (~$0.0X estimated)
    wiki: Acquired 10 new, skipped 0 duplicate
    wiki: Normalizing 10 source(s)
    wiki: Extracting from 10 source(s)
    wiki: [10/10] Extracted <file>
    wiki: Extracted labels from 10 doc(s)
    wiki: Recording 10 document(s)
    wiki: Mirrored vault to graph — N nodes, M rels
    wiki: Compile complete — 10 new source(s) indexed
    wiki: linked 10 doc(s) to their File nodes (MIRRORS)
    wiki: linked K doc-to-doc reference(s) (LINKS_TO)
    wiki: linked vault 'opentrace-demo' to repository 'local/ot-demo' (DOCUMENTS)
  Autoprune: no orphans found.
Done in ~40s.
```

### What to notice

- **Code walk first, no LLM.** The `Scanning` / `Processing` / `Extracted N classes` lines are tree-sitter only. The LLM fires only once `--wiki` reaches the doc pass.
- **Pre-flight cost estimate** before any LLM call (`via anthropic (~$X estimated)`).
- **One cheap call per doc does one job** — the title + one-line summary that becomes the doc's label in listings and search hits. That's the entire `Extracting` stage. The body is never rewritten.
- **The linking lines are deterministic.** `linked … (MIRRORS)`, `linked … (LINKS_TO)`, `linked vault … (DOCUMENTS)` all come after the LLM stage and use zero LLM calls: MIRRORS pairs a doc with the `File` the code walk saw, LINKS_TO parses the relative markdown links in the body, DOCUMENTS ties a repo-spawned vault back to its `Repository`.
- **No synthesis, planner, or merge lines.** There is no `Resolving concepts` / `Plan: P create, E extend` / `Executing` sequence and no entity-merge line. Those belonged to the concept-page layer (removed 2026-08-04) and the entity layer (same date). If you see them, you're on an old build.
- **`Done in N.Ns`** includes wiki + autoprune time.

```bash
opentraceai stats
```

You'll see counts for both layers: `Repository / File / Class / Function / Module` (code, tree-sitter, always there) plus `KnowledgeVault / KnowledgeDoc` (the doc pass). Two node types, not seven — the entity and concept-page types stopped being written on 2026-08-04.

---

## Section 2: The vault on disk (3 min · $0)

A vault directory is **metadata only**. Document bodies live verbatim in the shared, content-addressed corpus; the DB is a derived mirror of both.

```bash
find .opentrace/vaults/opentrace-demo -type f | sort
```

### What you'll see

```
.opentrace/vaults/opentrace-demo/.compile-log/<timestamp>.json
.opentrace/vaults/opentrace-demo/.vault.json
```

That's the whole layout — `.vault.json` plus a compile log, nothing else. There used to be a `pages/` dir here holding synthesized `concept/` and `file-summary/` markdown cross-linked with `[[wiki-link]]` syntax; synthesis stopped **2026-08-03** and the rest of the concept-page layer went **2026-08-04**, because the pages variant measured **88.4% against a 98.6% control (−10.2pp)** — see `agent/src/opentrace_agent/wiki/CLAUDE.md`. There is no `[[wiki-link]]` syntax anywhere in the product now.

```bash
cat .opentrace/vaults/opentrace-demo/.vault.json | python3 -m json.tool | head -40
```

`.vault.json` is the authoritative record — one entry per document (sha256, original name, root-relative `path`, epistemic `status`, `title`, `one_line_summary`, `corpus_path`) plus `last_compiled_at`. The graph mirror is rebuilt from this file by `vault attach`. Unknown keys from an older vault are ignored on load rather than crashing, so a pre-removal `.vault.json` still opens.

Same record, rendered for humans:

```bash
opentraceai vault show opentrace-demo
```

You get a `Documents:` count, then one `[status] filename` block per doc with its title and one-line summary. **Bodies aren't printed** — there's nothing to print but the source itself, and it's already on disk:

```bash
ls .opentrace/corpus/ | head -3
head -20 .opentrace/corpus/"$(ls .opentrace/corpus | head -1)"
```

That's one document's markitdown-normalised body, verbatim. Agents read these through the MCP `load_source` tool and sweep every one of them at once with `grep` (section 10) — which is what replaced reading a synthesized page. Note the corpus is sha-keyed and shared across vaults, so vault membership comes from the graph's `CONTAINS` edges, never from the directory listing.

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
- **God node** — *not a node type, never persisted*. Computed inline every time someone calls `analyze` (or hits `/api/highlights/gods`, or invokes the MCP tool). The whole definition is "SELECT every node ORDER BY degree DESC LIMIT N" where degree = incoming + outgoing edges. Any existing node type can rank — File, Function, KnowledgeDoc, or even a Community itself. Re-running after a re-index changes the ranking because degrees changed; re-running on the same graph gives the same answer. Useful for spotting the hubs the rest of the graph orbits — touch them and you affect everything.
- **Cross-community bridge** — an edge whose source and target sit in *different* communities. The structural seams holding otherwise-separate clusters together.
- **Cross-domain bridge** *(new in wikiv3)* — an edge crossing an ontological layer. Two layers are live: **code** (`Repository`/`Directory`/`File`/`Class`/`Function`/`Variable`) and **doc** (`KnowledgeVault`/`KnowledgeDoc`). The producers are `MIRRORS` (KnowledgeDoc → its `File` twin) and `DOCUMENTS` (Repository → the vault it spawned). A third **entity** domain still exists in the classifier so pre-2026-08-04 graphs keep classifying correctly, but nothing writes into it — the entity layer, and with it `DERIVED_FROM`/`MENTIONS` as bridge producers, was removed that day. The doc domain was called `page` until the same date.
- **Cross-cutting community** *(new in wikiv3)* — a community whose members span ≥2 domains. Signal that a subject legitimately exists across code and docs at once.

### What you'll see in `analyze`

Four sections, in order. Examples are roughly what you'll get on the opentrace-itself sandbox — your exact lines will differ.

**1. God nodes** — a mix of `File`, `Community`, and `KnowledgeDoc` types in one ranking:
```
God nodes (top 10 by degree):
    48  Community       Module cluster (48 nodes)
    36  File            main.py
    29  Community       Function cluster (29 nodes)
    12  KnowledgeDoc    Indexing
    ...
```
A `KnowledgeDoc` ranks on its `CONTAINS` + `LINKS_TO` + `MIRRORS` degree. Doc-side degrees are lower than they used to be: the two highest-volume edge types a doc node ever carried, `MENTIONS` and `CITES`, went with the entity and concept-page layers on 2026-08-04.

**2. Cross-community bridges:**
```
indexing.md [Doc cluster (9 nodes)] --LINKS_TO--> cli-flags.md [Module cluster (27 nodes)]
```
`LINKS_TO` is a relative markdown link one doc's author wrote to another doc — parsed mechanically, never inferred.

**3. Cross-domain bridges (code ↔ doc)** — this is the header `analyze` actually prints:
```
install-cli.md (doc/KnowledgeDoc) --MIRRORS--> install-cli.md (code/File)
```
The doc pass and the code walk both saw the same file, so it exists as two nodes; `MIRRORS` is the bridge, and it's what keeps the code-tree view one hop from any in-repo doc. This is the section that didn't exist before wikiv3.

**4. Cross-cutting communities (span ≥2 domains):**
```
Module cluster (48 nodes) — code+doc (48 members: {'code': 39, 'doc': 9})
```
Communities whose members aren't purely code or purely doc.

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

**Reading happens in the graph, not the manager.** A compiled vault mirrors into the graph as `KnowledgeVault` + `KnowledgeDoc` nodes. Close the manager and:
- **Click a `KnowledgeDoc` node** — the document's markitdown-normalised body renders in the Details side panel, exactly the way a `File` node shows its source. Reading a doc is just landing on its node, and what you read is what its author wrote.
- **Follow a `LINKS_TO` edge** out of that node — it's a relative markdown link the author wrote to another doc, so an internal reference is a graph hop.
- There is no separate page renderer. `WikiMarkdown.tsx` and `[[wiki-link]]` navigation were **removed 2026-08-04** with the concept-page layer (`agent/src/opentrace_agent/wiki/CLAUDE.md`); `components/wiki/` is now the vault manager only.

Now the AI Assistant panel:
- Ask: **"What's in the opentrace-demo vault?"**
- The agent will call the `list_vaults` LangChain tool (`chat/vaultTools.ts` exports only that one) and then read documents through the node/source endpoints. Same primitives the MCP server exposes. The `list_vault_pages` / `read_vault_page` tools that used to sit between them went with the concept-page layer.

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

`vault attach` mirrors a disk vault into a graph. Zero LLM cost — reads `.vault.json` + corpus files, writes `KnowledgeVault` / `KnowledgeDoc` nodes plus CONTAINS / LINKS_TO / MIRRORS edges, and copies any global-scope corpus files into the attaching project's corpus dir so each doc's `corpus_path` resolves locally.

```bash
# T2: completely different project
mkdir -p /tmp/ot-demo-b && cd /tmp/ot-demo-b
opentraceai index .                               # fresh empty graph (Repository node only)
opentraceai vault list                            # opentrace-demo: not attached
opentraceai vault attach opentrace-demo
opentraceai vault list                            # opentrace-demo: attached
opentraceai query "MATCH (n:Node) WHERE n.type = 'KnowledgeDoc' RETURN n.id LIMIT 5"
```

You'll get 5 `corpus::<sha>` document IDs from the same compiled vault, now queryable from a totally separate graph. Check `/tmp/ot-demo-b/.opentrace/corpus/` — it'll have the document bodies that the attach copied over.

---

## Section 6: Autoprune (2 min · $0)

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
  Autoprune: -1 documents, -1 corpus files
```

Two numbers, one hop. A document that vanished from disk between runs has its `KnowledgeDoc` node deleted (which takes its `CONTAINS` / `LINKS_TO` / `MIRRORS` edges with it) and its corpus body removed. `AutopruneReport` has exactly those two fields.

Confirm it's gone:

```bash
opentraceai query "MATCH (n:Node) WHERE n.type = 'KnowledgeDoc' RETURN count(n)"
```

This used to be a multi-hop cascade with a **stale** state: a concept page that cited the deleted doc was either deleted (no citations left) or stamped `stale_since`, and `vault refresh-stale-pages` re-synthesized it for ~1 LLM call per page. All of it went with the concept-page layer on **2026-08-04**. **There is no staleness concept in the wiki layer any more** — a document is stored verbatim, so it can't drift from a source it never restated. Don't re-introduce `stale_since`; see `agent/src/opentrace_agent/wiki/CLAUDE.md`.

---

## Section 7: URL + single-file ingestion (2 min · ~$0.05)

`index --wiki` accepts a URL or single file in addition to a directory. Both skip the `DirectoryWalker` entirely (so no fake Repository/File nodes for one URL) and go through a single-source pipeline that builds one `SourceInput` and feeds it to the unified doc pass — one cheap LLM call → the document's title + one-line summary, body verbatim in the corpus. A single-file/URL input *requires* `--wiki` (there's no code to walk, so plain `index` rejects it).

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
    wiki: Extracted labels from 1 doc(s)
    wiki: Compile complete — 1 new source(s) indexed
Done in ~30s.
```

`sources/markdown/fetchers.py` rewrites arXiv abstract URLs to the PDF before markitdown; the rewritten PDF URL is only used for the fetch, and the original `/abs/` URL is what gets recorded as the run's source.

```bash
opentraceai query "MATCH (n:Node) WHERE n.type = 'KnowledgeDoc' RETURN n.id, n.name, n.properties LIMIT 3"
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

> The cheap tier applies here too: the per-doc labelling call runs on the provider's cheap model (Haiku / Flash / gpt-4.1-mini). There is no second, flagship call to compare it against — the flagship tier existed for cross-document concept synthesis, removed 2026-08-03. `OT_LLM_PROVIDER` picks the backend; the `wiki_summary` role resolution picks the model within it.

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
- New in wikiv3: `list_vaults`, `load_source`, `overview`, `find_cross_cutting_communities`, `provenance`, `find_orphans`, `grep`, `get_god_nodes`

  Four vault tools were removed 2026-08-04 and won't be in the list: `find_pages_mentioning` / `find_entities_mentioned_by` went with the LLM-extracted entity layer they traversed, and `list_vault_pages` / `read_vault_page` with the concept-page layer they read. `grep` answers "which documents discuss X" and `load_source` returns a verbatim body — see `agent/src/opentrace_agent/wiki/CLAUDE.md`.

Try the pair that replaced them: `grep(pattern="autoprune", scopeId="opentrace-demo")` sweeps **every** member document's full body and returns verbatim lines, each labelled with the doc's title, epistemic status, and display path; `load_source(nodeId="corpus::<sha>")` then returns one of those documents whole. Exhaustive contact plus a verbatim read — no paraphrase layer in between.

For a real demo, configure your MCP client to point at `opentraceai mcp` and ask it "what does the opentrace-demo corpus say about autoprune?" — it should reach for `grep` and then `load_source`, not a ranked search.

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
