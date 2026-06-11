---
name: benchmark
description: |
  Score the LLM extractor against the hand-labelled corpus.
  Use when: "/benchmark", "check extraction quality", "run the eval".
allowed-tools: Bash
---

Runs `opentraceai-bench llm-extraction-eval`. Measures entity precision/recall,
edge precision/recall, and confidence-tier calibration against the corpus at
`agent/src/opentrace_agent/benchmarks/corpus/`.

## Arguments
$ARGUMENTS

- `--corpus <dir>` — alternate corpus directory
- `-v` — per-example breakdown
- `--output json` — structured JSON

## Instructions

Run `opentraceai-bench llm-extraction-eval $ARGUMENTS`. Highlight whether the
release bar passed (entity precision ≥90%, edge precision ≥80%, calibration
within 0.15). If not, surface which tier failed.
