# Wiki

Knowledge-compilation pipeline that turns raw uploaded files into a
folder of interconnected markdown pages — the "vault" — and mirrors the
result into the graph for the OT-1732 retrieval surface.

## Layout

```
paths.py              — vault dir resolution + path-traversal validation
vault.py              — VaultMetadata pydantic model + .vault.json read/write
slugify.py            — title → slug, collision suffix, tombstones
index.py              — vault index (slug, title, summary) read from .vault.json
llm.py                — Anthropic client wrapper + BYOK key resolver
ingest/
  types.py            — WikiPipelineEvent, WikiPhase, Plan, PlanItem, SourceInput
  sources.py          — Acquire stage: file inputs + sha256 dedup
  normalize.py        — Normalize stage: lazy-imported markitdown wrapper
  plan.py             — Plan stage: one LLM call → structured plan
  execute.py          — Execute stage: per-action create/extend LLM calls
  persist.py          — Persist stage: atomic disk writes + .vault.json update
  graph_writer.py     — OT-1732 Phase 4: mirror vault to graph (WikiVault/WikiPage/Source + CONTAINS/CITES/LINKS_TO)
  pipeline.py         — Composer (sync generator); accepts optional graph_store=
```

## Storage layout

```
~/.opentrace/vaults/<vault-name>/
  pages/<slug>.md
  .vault.json
  .compile-log/<iso-ts>.json
```

Override the root with `OT_VAULT_ROOT`. **Disk is the source of truth for
page bodies**; the graph holds metadata + relationships only. Bodies belong
in their natural blob store, not on graph nodes (LadybugDB caps STRING
properties at ~4 KB; vault bodies typically run 5–20 KB). See
[OT-1745](https://linear.app/opentrace/issue/OT-1745) for moving the disk
layer to a production-grade backing store.

## Graph mirror (OT-1732 Phase 4)

When `run_compile(graph_store=...)` is called, the post-compile vault state
is mirrored into the graph after disk writes succeed:

- `WikiVault` node — one per vault. Carries `vault`/`last_compiled_at`/`summary`.
- `WikiPage` nodes — one per slug. Carries `slug`/`vault`/`kind`/
  `one_line_summary`/`revision`/`last_updated`. For pages compiled this run,
  `agent`/`model`/`session`/`confidence` provenance is also stamped (Phase 5);
  pages not in `compiled_slugs` keep their existing provenance.
- `Source` nodes — one per ingested sha256. Metadata-only (`sha256`/
  `filename`/`acquired_at`/`size_bytes`) — raw source bytes are NOT stored.
- `CONTAINS` edges — WikiVault → WikiPage and WikiVault → Source.
- `CITES` edges — concept WikiPage → source-summary WikiPage (derived from
  `source_shas` on each concept page); source-summary WikiPage → Source
  (1:1 by sha).
- `LINKS_TO` edges — per `[[Title]]` occurrence in any page body.

Failures during the graph write are caught and emitted as a non-fatal
warning event. The on-disk vault remains valid even when the mirror falls
behind. Re-sync via:

```
opentraceai wiki backfill <vault>
```

The CLI `wiki compile` command auto-discovers a graph DB via `find_db()`
and mirrors by default; pass `--no-graph` to skip.

## Wiki-link parser

`graph_writer.parse_wiki_links(body)` extracts targets from `[[Title]]` and
`[[Title|alias]]` Obsidian-style forms. Targets are stripped of whitespace
and deduped in document order. The renderer in `ui/src/components/wiki/`
uses the same syntax.

## v2 status (OT-1732)

OT-1733 (v1, pre-OT-1732) was disk-only. OT-1732 added:

- Vault content as graph nodes (Phase 4)
- Provenance stamped at compile time (Phase 5)
- Vault-scoped `search_graph` / `traverse_graph` / `overview` / `grep`
- The `wiki backfill` command for re-syncing

Still deferred (post-OT-1732):

- Source bytes are NOT retained after compilation. SHA-256 dedup via
  `.vault.json` (and now the `Source` node) is the only memory of past uploads.
- Pages are LLM-managed. Human edits are not preserved across compilations.
- Real LLM-synthesis confidence — currently a `0.0` placeholder
  ([OT-1744](https://linear.app/opentrace/issue/OT-1744)).
- Production blob store — currently local disk
  ([OT-1745](https://linear.app/opentrace/issue/OT-1745)).
- Per-vault ingestions are serialized via `fcntl.flock` on `.vault.json`;
  remote-blob-store equivalent is open in OT-1745.
