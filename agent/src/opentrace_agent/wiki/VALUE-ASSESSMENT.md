# Handoff: does an in-repo documentation vault add value?

Self-contained brief for a session with no prior context. Written 2026-07-30
after six benchmark runs (~$165) against OpenTrace's `feat/wiki` branch.
Companion document, in the **vault-benchmark** repo (branch
`fix/harness-accuracy-and-cost`): `FINDINGS.md` — what that benchmark can and
cannot measure, the measured noise floors, and how to reproduce them.

---

## The conclusion

**For documentation that already lives inside the repository, read by a frontier
model that can open files, the doc vault adds no detectable answer-quality value
and costs ~18% more to run. Net negative for that configuration.**

Two things this does **not** say:

1. It does not say the vault is worthless. It says nothing about the case the
   feature was designed for — docs *outside* the repo, a corpus too large to
   sweep, or a cheaper model that cannot afford to read everything. That case is
   untested.
2. It is not a pure measurement claim. The benchmark cannot detect *benefit* at
   all (see "What the benchmark cannot tell you"). Confidence comes mainly from
   the mechanistic argument below, which does not depend on the benchmark.

---

## What was tested

- **Repo under test:** `Gentleman-Programming/engram` @ `763a6ba` — a real Go
  project with 401 `.md` files including a large `openspec/` design-history tree
  and a 90 KB `DOCS.md`.
- **Two arms, blind A/B, same questions, same model.** One arm's graph was built
  with `opentraceai index ./ --wiki` (docs indexed as `KnowledgeDoc` nodes with
  labels, epistemic status, entity graph (since removed — see the update at the
  end), doc→doc `LINKS_TO`, `MIRRORS` twins).
  The control was built with plain `opentraceai index ./` (code only).
- **Both arms restricted to the OpenTrace MCP tools** — no native
  `Bash`/`Read`/`Grep`. Both could still read any file via `load_source` on a
  `File` node.
- Arms and grader: `claude-sonnet-5` at `high` effort. Grader scores each answer
  1–5 on Correctness, Completeness, Traceability, Faithfulness (max 20/question).

---

## Evidence

`Δ` = wiki arm's margin in percentage points.

| # | vault shape | Qs | notes | wiki | code | Δ |
|---|---|---|---|---|---|---|
| 1 | concept pages | 14 | corrupted payloads | 88.4% | 98.6% | **−10.2** |
| 2 | corpus-only | 15 | corrupted payloads, **control-arm tax** | 98.0% | 94.2% | +3.8 |
| 3 | corpus-only | 15 | corrupted payloads, **control-arm tax** | 97.3% | 93.2% | +4.2 |
| 4 | corpus-only | 6 | clean | 92.1% | 97.5% | **−5.4** |
| 5 | corpus-only | 6 | clean, symmetric read caps | 87.1% | 98.8% | **−11.7** |
| 6 | corpus-only | 6 | clean, `grep` denied to both arms | 95.0% | 97.5% | **−2.5** |

**Runs 2 and 3 are the only positives and both are invalid.** `list_nodes` and
`search_graph` advertised `KnowledgeDoc` to *both* arms, including the control,
whose graph contains none — 19 wasted tool calls across 8 questions hunting a
layer that wasn't there. We were taxing the control and reading the difference as
a vault benefit. Fixed in commit `175b5a1`; the sign flips once removed.

**Measured noise floors** (both reproducible, see the benchmark repo's `FINDINGS.md` §4):
- Grader: **±0.5 pts** on the A−B gap — replaying identical answers past a fresh
  grader moved it 0.5. The grader is not what moves these numbers.
- Agent: **~7.5 pts** on the gap — runs 4 and 5 used identical config and
  questions and produced −6.5 and −14.0.

So: sign consistently negative across three clean runs and both arm slots;
magnitude unreliable. Run 6's −2.5 is inside the agent-noise floor, i.e.
consistent with *no difference*.

The wiki arm also consistently did **more** work: 222 vs 197 searches and 212 vs
148 tool calls on comparable runs, at ~18% higher cost.

### The `concepts` field was competing with the entity inventory (2026-08-03)

A separate, much cheaper measurement (48 docs, two runs per variant, ~$1), run
when concept-page synthesis was removed. The question: does dropping the per-doc
`concepts` field from the extraction schema cost anything, given both fields come
out of the same call?

It doesn't — it *pays*. Removing the field raised entity yield ~20%:

| | entities | edges | `idea` (mean) | `event` (mean) | `service` (mean) |
|---|---|---|---|---|---|
| with `concepts` | 386 / 352 | 332 / 296 | 35.5 | 15 | 237.5 |
| without | 432 / 450 | 369 / 379 | 69 | 29.5 | 237 |

The entity and edge ranges do not overlap across variants. The gain is
concentrated almost entirely in `idea` and `event` while `service` — the
mechanically-obvious type — is flat, which is the signature of the two fields
contending for the same content rather than of a general quality shift.
Run-to-run noise for reference: two identical-config runs differed by 34 entities
and agreed on only ~65% of labels (Jaccard 0.65), so the cross-variant effect is
well outside noise.

**Consequences.** Recurring themes surfaced as `idea` entities instead, so a
separate concept layer had nothing left to add. That half of the reasoning is now
moot — the entity inventory was itself removed 2026-08-04 (see the update at the
end). What survives is the general lesson: fields in one extraction schema are
**not independent** — adding one costs the others attention. Measure before adding
a second.

---

## Why this is probably not just an instrument artifact

Component by component, for docs that are already in the repo:

| vault component | why it adds little in-repo |
|---|---|
| title + one-line gloss | duplicates the path. `openspec/changes/memory-conflict-audit/spec.md` is self-describing in a way `handleFoo()` never is |
| epistemic `status` | *derived from the path* (`openspec/` → design history). The agent makes that inference itself |
| entity graph | measurably adds noise: entities took ~half the top-3 search slots, and content-free ones (the project's own name) won slot 1 on 6 of 12 realistic queries. **Acted on: removed 2026-08-04** |
| corpus copy of the body | byte-identical to the file — same text behind an extra hop |
| doc→doc `LINKS_TO` | edges are accurate, but cover 189 of 401 files, so exhaustiveness answers are less trustworthy than grepping the links |

The pattern: **every component is either inferable from the path, noisier than the
raw text, or a lossy subset of it — because the source is already perfectly
indexed by the filesystem.** An index earns its keep by substituting for expensive
search; in-repo, the thing it substitutes for is nearly free.

Corroborating detail: run 6 gave the wiki arm the *highest* engagement recorded
(doc-layer pickup 6/6) and it still lost. Engagement is not the bottleneck.

---

## What the benchmark cannot tell you

**The control arm scores 97–99%, hitting 20/20 on five of six questions.** There
is no headroom, so the design can measure the vault *harming* an agent and cannot
measure it *helping*. Treat any "no significant difference" from this harness as
uninformative about benefit, not as evidence of its absence.

Run 6 tested the obvious remedy — deny both arms `grep` — and it failed: the
control only moved 98.8% → 97.5%, because it never needed grep. It reads files
directly with `load_source` on `File` nodes. The ceiling is held up by that, so
lowering it means making the control unable to read documents at all, which is
either a benchmark-only switch in product code or a rigged comparison.

---

## What still looks worth keeping

- **`MIRRORS`** (doc ↔ code File twin). Cheap, no measured downside, and it
  answers "which docs cover this file" — nothing else does.
- **The gloss, conditionally.** engram's paths are informative. A repo with
  `docs/1234.md` or Confluence-exported filenames would make the label carry real
  weight. The finding is scoped to informative paths.
- **Human-facing browsing.** Never tested. A person scanning a corpus is a
  different consumer from an agent, and the ceiling argument doesn't apply.

---

## Two fixes that worked technically and changed nothing

Recorded so they are not re-attempted as if new.

1. **Coverage annotation does not repair coverage.** `find_orphans` was made to
   report its population. In run 6 the annotation reached the agent verbatim
   (`"population": 189 … "not over the filesystem"`), the agent used it correctly
   ("141 of the corpus's 189 KnowledgeDoc nodes"), and it *still* lost that
   question by 3.5 points — the question is about documents in the repo, and 189
   of 401 is the wrong population however honestly labelled.
2. **Symmetric read caps fixed the diagnosed mechanism and not the verdict.** A
   200 K (File) vs 40 K (KnowledgeDoc) asymmetry meant the same 90 KB document
   returned 2.26× more text depending on which node type you entered through; it
   caused run 5's largest single loss. After levelling, that question flipped to
   the wiki arm for the first time — and the run was still negative overall.

---

## State of the code

Nothing is blocked; `index --wiki` is **opt-in**, so none of this requires
unshipping anything. It bounds the *claim*: "your docs, indexed and searchable
alongside your code" is supported; "makes your agent answer better" is not.

**`opentrace` @ `feat/wiki`** (pushed):
- `0b1984e` `fix(store)` — FTS results sorted by score
- `175b5a1` `fix(mcp)` — unparseable oversized results (27% of all tool results
  were invalid JSON, 39% of `search_graph`), asymmetric body caps,
  `list_nodes` enumeration + paging, doc types advertised only when present,
  `status` in `load_source` payloads, `find_orphans` population
- `f1e2c97` `feat(wiki)` — corpus-only default, `--wiki-concept-pages` opt-in,
  doc→doc `LINKS_TO`, describe-don't-assert gloss prompt, dedup stamping
- `3335194` `docs` — 9 public docs files brought in line

**`vault-benchmark` @ `fix/harness-accuracy-and-cost`** (pushed): harness
accuracy + cost fixes, `FINDINGS.md`, `regrade.sh` + `compare_grades.py`,
`ARM_NO_GREP`.

---

## Open decisions

1. **OT-1732 success criterion 1 is not met** — and the ticket is in review.
   It reads: *"quality **matching or exceeding** what the same agent achieves
   over a folder of markdown files."* That is exactly what runs 4–6 measured, and
   the answer is no, for in-repo docs. (The ticket's *scope* is the seven MCP
   retrieval primitives; it never listed concept pages — an earlier version of
   this document said it did, wrongly.) Recorded as a comment on the ticket
   2026-07-31. The decision to make explicitly: re-scope criterion 1 to the
   out-of-repo case, or accept the negative for in-repo docs. Note the seven
   primitives themselves are built and working — it's the comparison bar that
   fails, not the tools.
2. ~~**Concept pages: recommend dropping rather than deferring.**~~ **DONE
   2026-08-03 — dropped.** The recommendation stood on the pages variant being
   the worst result on record (−10.2pp) with an understood mechanism: restating a
   source in the model's own voice strips its hedges, tense and attribution.
   Removed: page synthesis (`resolve.py`, `execute.py`, `verify.py`), the per-doc
   `concepts` field, `refresh_stale_pages()`, `--wiki-concept-pages`,
   `--refresh-stale-pages`, `OT_WIKI_CONCEPT_MIN_SOURCES`. The **read** surface
   survives (`vault show --page`, `read_vault_page`/`list_vault_pages`, `CITES`
   provenance, the UI renderer) so vaults compiled before this still show their
   pages; nothing produces new ones. The salvage option — concepts as bodiless
   graph nodes — was closed at the same time, see the measurement below.
3. **The only experiment left worth running:** put the docs *outside* the repo —
   ingest a docs site or wiki export not present on disk — so the control
   genuinely cannot reach them. Needs a question set written against those docs.
   This is a different experiment, not another run of this one.
   **First datapoint (2026-07-31):** a purpose-built harness now exists
   (`vault-benchmark-2/out-of-repo/`) — vault-only arm vs native-tools-over-raw-
   folder arm, blind grading, leak checks. Run 1 on the 15-doc smoke fixture:
   97.3% vs 97.7%, a tie inside noise, as pre-registered for a clean well-named
   corpus. Read as **sufficiency, not superiority**: an arm with zero file
   access matched full file access on quality at comparable cost — the first
   measured support for the access claim. Superiority (better/quicker/cheaper
   than grep) remains unshown; the informative fixture (real messy export, 50+
   docs, opaque names) has not been run. The exhaustiveness weakness recurred
   (a confident false-negative on the coverage question — third benchmark in a
   row).

## Traps that will mislead a fresh session

- An API 529 arrives as `subtype: "success"` with `is_error: true` and the error
  text as the result. Two were graded as answers before this was caught.
- Self-reported `vault: yes/no` footers disagree with measurement in both
  directions. Trust `out/pickup.tsv` (a real `corpus::<sha>` reference).
- `--disallowedTools` genuinely enforces, but `ToolSearch` can still *list* banned
  tools, so arms burn calls hunting them.
- Cost was under-reported ~13% until the grader, generator, seed and wrap-up
  calls were counted. Read `out/cost.txt`, not the score report.
- Byte-identical files share ONE content-addressed `KnowledgeDoc`. Two paths, one
  node — this made a transcript look like the agent had opened a superseded spec
  when the graph only ever had one node for both.

---

## Update — the entity layer was removed (2026-08-04)

This document's component table already scored the entity graph as *measurably
adding noise*. Three further benchmark runs settled it, and the layer is gone:
`Idea`/`Service`/`Module`/`Paper`/`Person`/`Event` extraction, `DERIVED_FROM`,
`SEMANTIC_EDGE`, `MENTIONS`, the merge stage, the two MCP traversal tools, and
the `search_graph` exclusion that had been papering over the crowding.

The five measurements, in order of weight:

1. **Zero usage across three runs.** Once corpus `grep` shipped, the agent never
   reached for an entity node to answer a question. That is the decisive one — an
   index layer nothing queries cannot pay for itself no matter how good it is.
2. **Search crowding.** Short entity names beat the labelled documents they were
   extracted from (BM25 length normalisation), taking ~half the top-3 slots on a
   25-doc index. The fix was to exclude them from search by default — which is an
   admission, not a repair.
3. **~65% run-to-run stability.** Re-ingesting the same corpus produced a
   materially different entity graph, so nothing downstream could treat presence
   or absence as a fact.
4. **Name fragmentation.** "Cold chain" / "Cold-chain integrity" / "Cold-chain
   monitoring" became separate nodes — splitting the documents the abstraction
   existed to join.
5. **Cross-type duplication.** `Midwest Beef Co` was extracted as both a
   `Service` and a `Person` within one corpus.

Plus a class of bugs with no cause other than the layer's existence (`MENTIONS`
restating `DERIVED_FROM`, twice), and a separate measurement showing the
entity fields competed with the doc summary inside the same extraction call.

What remains is what the benchmark actually used: **normalized bodies, a title +
one-line summary, epistemic `status`, author-written doc→doc `LINKS_TO`,
exhaustive `grep` / `list_nodes`, verbatim `load_source`.** The node types stay in
the schema so pre-removal graphs remain readable. Full decision record in
[CLAUDE.md](CLAUDE.md#closed).
