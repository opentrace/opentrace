# Notes from Platform Sync

Dana Reyes presented the ingest pipeline redesign at KubeCon 2025. The
redesign splits the ingest pipeline into a fetch stage and a parse
stage, which Dana Reyes authored over the last quarter.

Marco Lindqvist reviewed the proposal and signed off. The ingest
pipeline feeds the search indexer, so the search indexer team should be
looped in before the cutover.

Action items:

- [ ] schedule cutover review (owner: marco)
- [ ] update the runbook links in #platform
- [ ] archive the old design doc
