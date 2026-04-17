# Summarizer

One-line code summaries for graph nodes (functions, classes, files). Used by `cli/augment.py` to enrich an already-saved graph.

## Files

```
base.py     — Summarizer protocol, SummarizerConfig dataclass
flan_t5.py  — Xenova/flan-t5 implementation; batched, optionally cached
```

## Protocol

```python
class Summarizer(Protocol):
    async def init(self) -> None: ...
    async def summarize(self, batch: list[SummarizationInput]) -> list[str]: ...
    async def dispose(self) -> None: ...
```

`init` / `dispose` exist because model loading is expensive — call once per process. `summarize` is batched on purpose; per-call overhead dominates inference time for short snippets.

## Adding a Backend

Implement `Summarizer` and wire it into `cli/augment.py`'s factory. Things to think about:

- **Cold start.** Model load can take >10s. Don't init lazily inside `summarize()`.
- **Batching.** Honor `SummarizerConfig.batch_size`; very large batches OOM small GPUs.
- **Truncation.** Inputs longer than `max_input_length` must be cut, not rejected — augmentation should never fail an entire run because of one big file.

## Pitfalls

- **Flan-T5 outputs are often generic** ("This function does X") — don't rely on them as documentation. Their value is similarity search and clustering, not human reading.
- **No fallback on init failure.** If the model can't load (missing weights, no internet for first download), the entire `augment` command fails. Acceptable today; revisit if augmentation becomes a default step.
- **Cache keys are content-hash based.** Renaming a function with identical body returns the cached summary — fine for one-liners, but be aware if you start storing more context-dependent output.
