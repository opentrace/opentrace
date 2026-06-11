# LLM extraction eval corpus

Hand-labelled examples used by `opentraceai-bench llm-extraction-eval`.
Each example is a pair of files sharing a basename:

```
<id>.md     # input the extractor sees (typically converted by markitdown)
<id>.json   # ground truth — entities + edges with confidence tiers
```

See `agent/src/opentrace_agent/benchmarks/llm_extraction_eval.py` for the
JSON shape.

## Coverage target

Per the implementation plan, the v1 corpus should reach ~120 examples
covering:

| Source shape | Target |
|---|---|
| Prose (PDF / Word / EPub) | ~40 |
| Slides (PowerPoint) | ~15 |
| Tables (Excel / CSV / JSON) | ~15 |
| Image descriptions | ~30 |
| Audio transcripts | ~10 |
| Video transcripts | ~10 |

Examples are labelled by hand. Don't generate them from the extractor —
that would make the eval circular.

## Release bar

The harness compares predicted vs. ground truth and reports:

* Entity precision (must be ≥ 90%)
* Edge precision (must be ≥ 80%)
* Per-tier confidence calibration (each tier within 0.15 of empirical
  accuracy)

If any of these fail, LLM-derived features must not ship.
