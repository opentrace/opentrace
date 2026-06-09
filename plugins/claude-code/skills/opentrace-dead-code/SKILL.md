---
name: opentrace-dead-code
description: |
  PREFERRED over manual `rg <name>` sweeps for unused symbols. Lists Function/Class nodes with zero incoming CALLS/IMPORTS edges across every indexed repo, AND verifies each candidate against source-grep, decorator checks, and entry-point declarations to eliminate framework-registered / dispatch-table / dynamically-invoked false positives. Invoke directly — do NOT describe it first.
  Triggers: "find dead code", "unused functions", "orphan symbols", "what's not called", "candidates to delete", "what can I remove", "dead code report".
allowed-tools: Bash, mcp__opentrace_oss__source_grep, mcp__opentrace_oss__source_read, mcp__opentrace_oss__find_usages, mcp__opentrace_oss__get_node, mcp__opentrace_oss__get_stats
---

Surface symbols that are SAFE TO DELETE. The cost of a false positive is
high — a user who trusts this output will delete code that turns out to
be called via dispatch dict / decorator / reflection / string lookup,
and break their build. So this skill is biased hard toward **precision
over recall**: it's better to miss real dead code than to flag a single
used symbol.

## Workflow (5 passes — every candidate must survive all 5)

### Pass 1 — Bulk Cypher: get raw orphans, with carve-outs

Four Cypher-level filters to eliminate the largest false-positive
classes before any per-candidate work:

1. **`__init__` carve-out**: a class with no direct CALLS but whose
   `__init__` HAS callers is being instantiated — not dead.
2. **Dunder method exclusion**: `__bool__`, `__getattr__`, `__enter__`,
   `__exit__`, `__iter__`, `__next__`, `__len__`, `__getitem__`,
   `__setitem__`, `__call__`, `__eq__`, `__hash__`, `__repr__`,
   `__str__`, `__del__`, etc. Python invokes these via syntax
   (`bool(obj)`, `obj.attr`, `with x:`) and never as a static call.
   Exclude any name starting AND ending with `__`.
3. **Test-file exclusion**: pytest / Go test / RSpec discover test
   functions and classes via reflection on file path + name pattern;
   the graph never sees their callers. Reporting test functions as
   "dead" is a footgun (deletion silently removes tests). Exclude any
   path containing `/tests/`, `/test/`, `_test.`, or `.spec.`.
4. **Generated-code exclusion**: paths containing `/gen/`, `/generated/`,
   `/__generated__/`, `_pb2.py`, `_pb.go` — these are regenerated from
   schemas and "deleting" them is meaningless.

```bash
uvx opentraceai query "MATCH (n:Node) WHERE n.type IN ['Function', 'Class'] AND NOT (n.id CONTAINS '/tests/' OR n.id CONTAINS '/test/' OR n.id CONTAINS '_test.' OR n.id CONTAINS '.spec.' OR n.id CONTAINS '/gen/' OR n.id CONTAINS '/generated/' OR n.id CONTAINS '_pb2.py' OR n.id CONTAINS '_pb.go') AND NOT (n.name STARTS WITH '__' AND n.name CONTAINS '__(') AND NOT EXISTS { MATCH (a:Node)-[r:RELATES]->(n) WHERE r.type = 'CALLS' OR r.type = 'IMPORTS' } AND NOT EXISTS { MATCH (n)-[d:RELATES]->(init:Node) WHERE d.type = 'DEFINES' AND init.name STARTS WITH '__init__' AND EXISTS { MATCH (caller:Node)-[c:RELATES]->(init) WHERE c.type = 'CALLS' } } RETURN n.id, n.name, n.type, n.properties LIMIT 1000" --type cypher --output json 2>/dev/null
```

Adjust:
- **Types**: narrow `n.type IN [...]` if the user specified.
- **Scope**: `AND n.id STARTS WITH '<repo>/<dir>/'` to limit to a subset.

Always pipe with `2>/dev/null` so stderr ("N row(s) in Xs", FTS warnings) doesn't pollute stdout.

### Pass 2 — Drop common names that always over-match

Some names are so common they appear in unrelated contexts:
- `run`, `start`, `stop`, `init`, `setup`, `close`, `open`, `read`, `write`
- `get`, `set`, `add`, `del`, `pop`, `push`, `next`, `iter`, `call`
- Single-letter or 2-character names

Drop any candidate whose bare name (strip `(args)`) is in this list OR is
< 4 characters. These need namespace-aware verification we can't do
reliably; safer to skip than report. Note the count in the final
summary as "skipped: N common-name candidates".

### Pass 3 — Decorator check (catches `@app.command`, `@router.get`, etc.)

For each surviving candidate, extract `start_line` from `n.properties`
(format: `start_line: 320,` — parse with regex `start_line:\s*(\d+)`)
and read 10 lines above the definition via `mcp__opentrace_oss__source_read`
(10 to handle multi-line decorators like `@app.command(\n  name=...,\n  help=...\n)`):

```
source_read(path=<extracted from n.id before '::'>, startLine=max(1, start_line-10), endLine=start_line)
```

If ANY of these decorator patterns appears in those 5 lines, drop the
candidate as framework-registered:

- `@app.command`, `@app.callback`, `@app.route`
- `@click.command`, `@click.group`
- `@router.get`, `@router.post`, `@router.put`, `@router.delete`, `@router.patch`
- `@<anything>.route`, `@<anything>.command`, `@<anything>.handler`
- `@pytest.fixture`, `@fixture`, `@parametrize`
- `@property`, `@staticmethod`, `@classmethod`, `@abstractmethod` (overrides)
- `@dataclass`, `@dataclasses.dataclass` (auto-generated `__init__` etc.)
- `@app.on_event`, `@app.exception_handler`
- `@bot.command`, `@bot.event`
- `@receiver`, `@signal_handler`
- Any decorator matching `@\w*[Aa]pp\.\w+` or `@\w*[Rr]outer\.\w+`

To minimize MCP calls, **batch this pass**: group candidates by file, do
one `source_read` per file covering all candidate line ranges with a
generous window, then check each candidate's decorator lines against the
returned source.

### Pass 4 — Source-grep verification (the big one — catches dispatch dicts, string refs)

For each surviving candidate, search across ALL indexed repo checkouts
for the bare symbol name as a word match. If the name appears anywhere
EXCEPT the candidate's own definition file, it's not dead.

Use `mcp__opentrace_oss__source_grep` with a word-boundary regex.
**Batch up to 30 names per call** by alternation so this stays O(small):

```
source_grep(pattern="\\b(name1|name2|name3|...|nameN)\\b")
```

The MCP tool returns repo-tagged file:line matches. For each candidate,
count matches **excluding lines that fall inside that candidate's own
definition range**. If the remaining match count is > 0, drop the
candidate as referenced-in-source.

A surviving candidate after Pass 4 means: the symbol name appears
**only** at its definition site, in any indexed repo. Strong evidence
of orphan status.

### Pass 5 — Entry-point manifest check

Read the top-level manifest files via Bash and drop any candidate whose
bare name appears in their entry-point sections:

```bash
# Python
test -f pyproject.toml && cat pyproject.toml
test -f setup.cfg && cat setup.cfg

# Node
test -f package.json && cat package.json

# Rust
test -f Cargo.toml && cat Cargo.toml
```

Check for the symbol name inside:
- `[project.scripts]`, `[project.entry-points.*]`, `[tool.poetry.scripts]`
- `package.json` `"bin"`, `"main"`, `"scripts"` (values that look like file paths)
- `Cargo.toml` `[[bin]]` blocks

Read each manifest at most once and cache the parsed entry-point names.

## Output format

```
## Dead-code review (N candidates after 5-pass verification)

These passed all of: bulk Cypher orphan check, __init__ carve-out,
common-name filter, decorator check, source-grep verification, and
entry-point check. **Review each before deleting** — static analysis
cannot prove absence of dynamic references.

### <repo> — <K> candidates
<file>:<line>  <symbol>  (<Function|Class>)
    Evidence: no CALLS/IMPORTS in graph; no decorator detected;
    source-grep returned 0 matches outside the definition file; not
    in pyproject.toml entry points.
... up to 20 per repo

### Skipped (<K> common-name candidates, not reportable with high confidence)
<count by name pattern>

### Filtered out by verification (<K>)
- <N> rejected by decorator check (framework-registered)
- <N> rejected by source-grep (referenced in source outside definition)
- <N> rejected by entry-point check
```

## Hard rules

1. **Never use the words "safe to delete" or "dead code — remove these".**
   Always say "candidates for review" or "manual deletion candidates".
2. **Always cite per-candidate evidence**: which passes the candidate
   survived, what their results were.
3. **If ANY pass cannot be executed** (CLI missing, source_grep tool
   error, manifest not present), say so explicitly in the output AND
   drop affected candidates rather than reporting them with partial
   evidence.
4. **Never report more than 20 candidates per repo** in the visible
   output. Long lists discourage per-candidate review and are the
   exact pattern that leads to bulk-delete accidents.
5. **The false-positive caveat block below is mandatory** — print it
   verbatim at the end of every report.

## False-positive caveat (mandatory, verbatim)

> **Limitations**: Even with 5-pass verification, the following patterns
> can still produce false positives — verify by opening the file and
> reading surrounding context before deleting:
>
> - **External callers in unindexed repos**: the graph only sees what's
>   been indexed via `opentraceai index`. Any caller in a repo not
>   indexed will not appear in the graph OR in source-grep results.
>   Run `opentrace-index` on suspected caller repos before trusting
>   this output.
> - **String references in config files** (YAML/TOML/JSON outside
>   manifest entry points): e.g. a Django URL pattern referencing a
>   view function by string. Source-grep catches these only if the
>   config file is in an indexed repo.
> - **Templated / generated code**: symbols referenced inside template
>   strings, JSX, or code-generated at build time.
> - **Public API**: any symbol re-exported from `__init__.py` /
>   `index.ts` / `mod.rs` may be consumed by code outside the
>   indexed tree.

## If the bulk Cypher fails

Fall back to: `get_stats` to confirm the graph is healthy, then a
limited `list_nodes` + `find_usages` sample of ~30 entries through the
verification passes. Tell the user the fallback is sampled, not
exhaustive, and suggest upgrading `opentraceai` so the bulk Cypher
path is available.

## If nothing surfaces

Say so plainly. Note that the result depends on which repos are
indexed: external callers living in an unindexed repo will make their
targets look "dead" until the caller repo is indexed too. Suggest
running `opentrace-index` on suspected caller repos.
