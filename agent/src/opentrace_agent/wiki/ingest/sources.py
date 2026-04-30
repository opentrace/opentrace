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

"""Acquire stage — receive raw bytes, sha256, dedup against past ingestions."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass

from opentrace_agent.wiki.ingest.types import (
    SourceInput,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.vault import VaultMetadata


@dataclass
class AcquiredSource:
    sha256: str
    name: str
    data: bytes


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def acquire(
    inputs: Iterable[SourceInput],
    meta: VaultMetadata,
    out: list[AcquiredSource],
) -> Iterator[WikiPipelineEvent]:
    """Compute SHAs, drop duplicates (already in *meta.sources*), populate *out*."""
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.ACQUIRING,
        message="Acquiring sources",
    )
    seen_in_batch: set[str] = set()
    items = list(inputs)
    total = len(items)
    new_count = 0
    skipped = 0
    for i, item in enumerate(items, start=1):
        sha = _sha256(item.data)
        if sha in seen_in_batch:
            skipped += 1
        elif sha in meta.sources:
            skipped += 1
        else:
            out.append(AcquiredSource(sha256=sha, name=item.name, data=item.data))
            seen_in_batch.add(sha)
            new_count += 1
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_PROGRESS,
            phase=WikiPhase.ACQUIRING,
            message=f"Hashed {item.name}",
            current=i,
            total=total,
            file_name=item.name,
        )
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.ACQUIRING,
        message=f"Acquired {new_count} new, skipped {skipped} duplicate",
        current=total,
        total=total,
        detail={"new": new_count, "skipped": skipped},
    )
