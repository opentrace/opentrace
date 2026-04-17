# Sources

Source discovery and language-specific symbol extraction. A **Source** is a category (e.g. `code`); a **Loader** is a provider implementation under that source. Today only `code/` is populated.

## Layout

```
code/
  directory_walker.py   — Local filesystem walk; emits Directory/File nodes
  git_cloner.py         — Clone remote repos into a temp dir before scanning
  manifest_parser.py    — Read go.mod / package.json / pyproject.toml for module paths
  import_analyzer.py    — Resolve imports per language using the existing tree-sitter AST
  extractors/
    base.py             — SymbolExtractor protocol, dataclasses (CodeSymbol, CallRef, ...)
    python_extractor.py
    typescript_extractor.py
    go_extractor.py
    generic_extractor.py — Table-driven fallback for unsupported languages
```

## Architecture

- **Two-phase per file:** extract symbols → register them → (later, in `pipeline/resolving.py`) resolve calls. The two-phase split is what lets a method in file A call a method in file B that hasn't been parsed yet.
- **Reuse ASTs.** Extraction stores `root_node` on `ExtractionResult`; `import_analyzer` consumes the same node. **Never call `parser.parse()` twice on the same source** — that was a real perf regression.
- **Bare vs attribute calls.** `CallRef` distinguishes `foo()` (bare) from `self.foo()` / `fmt.Println()` (attribute). Resolution strategies depend on which kind it is.
- **Go receiver bookkeeping.** Go method extractors set `_receiver_var` and `_receiver_type` attrs on the `FunctionNode` so the resolver can match `r.method()` calls against the correct receiver type.

## SymbolExtractor Contract

```python
class SymbolExtractor(Protocol):
    language: str
    def extract(self, file_path: str, source: bytes) -> ExtractionResult: ...
```

`ExtractionResult` carries:
- `symbols: list[CodeSymbol]` — class/function/variable definitions
- `calls: list[CallRef]` — unresolved invocations
- `derivations: list[DerivationRef]` — base-class / interface relationships
- `root_node` — the tree-sitter root, kept for downstream import analysis

## Adding a Language

Pick the right pattern:
- **Bespoke extractor** (Python/TS/Go) — write a new `*_extractor.py` if the language has structurally novel features (Python decorators, Go receivers, TS generics).
- **Generic extractor** — extend the per-language config table in `generic_extractor.py` for languages with a standard "function/class declaration" shape.

You also need:
1. A tree-sitter grammar package installable via `uv add tree-sitter-<lang>`
2. An entry in the language→extractor registry (search `extractors/__init__.py` for the pattern)
3. Cross-validation fixtures under `../../tests/fixtures/<lang>/` (see `/tests/CLAUDE.md`)

## Pitfalls

- **Relative imports need directory context.** Python's `from .foo import bar` requires the analyzer to know the file's package path; missing it silently drops the mapping.
- **Manifest parsing is best-effort.** A malformed `go.mod` won't crash but will leave external imports unresolved — they'll surface as orphan `pkg:*` nodes.
- **AST node names differ across grammars.** Kotlin uses `simple_identifier` (not `identifier`); Rust trait methods are `function_signature_item` (not `function_item`). Validate against the grammar's `node-types.json` before hardcoding.
- **YAML grammar fails to build for WASM** (C++ external scanner). It works in Python tree-sitter but is excluded from the UI build — keep extractor logic agnostic of "all my languages will work in the browser too".
