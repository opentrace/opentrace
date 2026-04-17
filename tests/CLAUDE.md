# Tests

Shared test fixtures for cross-validating the Python and TypeScript extractors and for integration-testing the full pipeline. These are **not** unit tests — each subsystem's unit tests live within that subsystem (`agent/tests/`, `ui/src/**/__tests__/`).

## Layout

```
cross_validation/
  test_extractors.py     — Validates Python extractors against golden .expected.json files
fixtures/
  cross-validation/      — Language-agnostic golden test cases (TS arrow functions, calls, etc.)
  python/                — Python-specific: extraction/ (unit) + imports/ (analyzer) + project/ (integration)
  typescript/            — Same layout for TypeScript
  go/                    — Same layout for Go
  c/ cpp/ csharp/ java/ kotlin/ ruby/ rust/ swift/  — Same pattern per language
```

## Fixture Conventions

### Extraction fixtures (`<lang>/extraction/`)

Each test case is a pair:
- `<name>.<ext>` — source file input (e.g., `classes.py`, `functions.go`)
- `<name>.expected.json` — golden output: expected `CodeSymbol[]` as JSON

The `expected.json` encodes exact symbol names, types, and line numbers. Changes to the extraction format must update all relevant `.expected.json` files — there's no auto-regeneration.

### Import fixtures (`<lang>/imports/`)

`<name>.fixture.json` — self-contained test describing an import statement, the file context, and expected resolution result. Used by `import_analyzer` tests on both Python and TS sides.

### Project fixtures (`<lang>/project/`)

Multi-file mini-codebases for integration testing:
- Pipeline integration tests in `agent/tests/` index these directories end-to-end
- Benchmark accuracy levels (`tests/fixtures/level{1,2,3}`) reuse this structure

## Cross-Validation Guarantee

The Python agent and TS browser pipeline implement the **same** extraction logic independently. Fixtures here are the contract:

1. Python test (`cross_validation/test_extractors.py`) runs the Python extractor on each fixture and asserts against `.expected.json`
2. TS tests (`ui/src/components/pipeline/__tests__/`) run the TS extractor on the same fixture and assert against the same `.expected.json`

If one extractor changes behavior, the fixture stays fixed, and the other extractor's test will catch the divergence. **Never update an `.expected.json` without running both test suites.**

## Adding a Fixture

1. Create `<lang>/extraction/<name>.<ext>` with the source code
2. Run the extractor on it and manually verify the output
3. Save the verified output as `<name>.expected.json`
4. Run `make test` from the repo root — both Python and TS suites should pass

For a new language: create the directory `tests/fixtures/<lang>/extraction/` and follow the same pair convention.

## Pitfalls

- **Exact line numbers matter.** Fixtures encode `start_line` / `end_line`; inserting a blank line in a `.py` fixture silently breaks the golden file.
- **No auto-regen tool.** If extraction format changes (field rename, new field), you must manually update every `.expected.json`. Grep for the old field name across `tests/fixtures/`.
- **Fixture scope is cumulative.** Some fixtures intentionally combine features (`mixed.py`) to test interactions; don't split them into single-feature files.
