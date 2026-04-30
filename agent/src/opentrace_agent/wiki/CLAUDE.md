# Wiki

Knowledge-compilation pipeline that turns raw uploaded files into a
folder of interconnected markdown pages — the "vault" — and exposes it
to the UI and to filesystem-reading agents.

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
  persist.py          — Persist stage: atomic writes + .vault.json update
  pipeline.py         — Composer (sync generator, mirrors pipeline/pipeline.py)
```

## Storage layout

```
~/.opentrace/vaults/<vault-name>/
  pages/<slug>.md
  .vault.json
  .compile-log/<iso-ts>.json
```

Override the root with `OT_VAULT_ROOT`.

## v1 constraints

- Source bytes are NOT retained after compilation. SHA-256 dedup via
  `.vault.json` is the only memory of past uploads.
- Pages are LLM-managed. Human edits are not preserved across compilations.
- Filesystem reads only for agent consumption. No new MCP tools in v1 —
  agents `cat`/`grep` the folder directly.
- Per-vault ingestions are serialized via `fcntl.flock` on `.vault.json`.

See `/home/callum/.claude/plans/the-timeline-is-a-temporal-nest.md`
for the full v1 plan and the v2 deferral list.
