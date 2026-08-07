# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Persist stage — .vault.json source index + compile-log entry."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.ingest.types import (
    NormalizedSource,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.vault import (
    IngestedSource,
    VaultMetadata,
    save_metadata,
)


def persist(
    acquired: list[AcquiredSource],
    meta: VaultMetadata,
    metadata_path: Path,
    log_dir: Path,
    normalized: list[NormalizedSource] | None = None,
) -> Iterator[WikiPipelineEvent]:
    """Record the ingested documents in vault metadata + a compile-log entry.

    Document *bodies* are not written here — they go to the shared corpus dir
    earlier in the composer. This stage owns ``.vault.json``'s source index
    (sha → filename, ingest time, navigation label, epistemic status) and the
    per-run audit log.
    """
    total = len(acquired)
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.PERSISTING,
        message=f"Recording {total} document(s)",
        total=total,
    )

    now = datetime.now(timezone.utc).isoformat()

    # Update sources index. Labels come from the DocExtraction stage via the
    # NormalizedSource (matched by sha); persisted here so disk-only vaults
    # keep them for a later ``vault attach``.
    label_by_sha = {n.sha256: n for n in (normalized or [])}
    for src in acquired:
        norm = label_by_sha.get(src.sha256)
        meta.sources[src.sha256] = IngestedSource(
            sha256=src.sha256,
            original_name=src.name,
            ingested_at=now,
            title=getattr(norm, "title", "") or "",
            one_line_summary=getattr(norm, "one_line_summary", "") or "",
            status=src.status,
        )

    meta.last_compiled_at = now

    # Write metadata last (atomic).
    save_metadata(metadata_path, meta)

    # Append compile-log entry.
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{now.replace(':', '-')}.json"
    log_path.write_text(
        json.dumps(
            {
                "compiled_at": now,
                "vault": meta.name,
                "new_sources": [{"sha256": s.sha256, "name": s.name} for s in acquired],
            },
            indent=2,
        )
    )

    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.PERSISTING,
        message=f"Recorded {total} document(s) in {metadata_path.name}",
        current=total,
        total=total,
    )
