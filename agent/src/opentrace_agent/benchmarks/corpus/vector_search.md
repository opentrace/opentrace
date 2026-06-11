# Vector Search Notes

Our embedding service stores document vectors in pgvector. pgvector
implements approximate nearest-neighbour search, which is what makes
query latency acceptable at our corpus size.

The embedding service calls the tokenizer module to normalise input
before embedding. Exact nearest-neighbour search was rejected during
design review: approximate nearest-neighbour search replaces it in
every production query path.

Configuration notes: set `--probes 10` for recall above 0.9, and keep
`OT_EMBED_BATCH` at its default unless ingest throughput becomes a
bottleneck. These flags are documented in the runbook.
