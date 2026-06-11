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

"""Persist stage — atomic page writes + .vault.json + compile-log entry."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.ingest.types import (
    CompiledPage,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.vault import (
    IngestedSource,
    PageMeta,
    VaultMetadata,
    save_metadata,
)


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp_path, path)
    except BaseException:
        Path(tmp_path).unlink(missing_ok=True)
        raise


# Pages shorter than this aren't substantive enough for drift detection to
# be meaningful — half of a 50-char stub is still a stub.
_DRIFT_MIN_BEFORE_CHARS = 200
_DRIFT_THRESHOLD = 0.5


def _drift_metrics(before: str, after: str) -> dict[str, float | bool]:
    """Quantify how much content the LLM may have lost during an extend.

    Returns a dict with:
      - ``chars_ratio`` — ``after_chars / before_chars`` (1.0 if before was empty)
      - ``token_jaccard`` — set-overlap of whitespace-split lowercased tokens
      - ``drift_suspected`` — True when the page was substantive (>200 chars
        before) and either signal dropped below 0.5

    Cheap, deterministic, no extra deps. Logged into ``.compile-log/`` so a
    human can audit pages flagged for drift.
    """
    before_chars = len(before)
    after_chars = len(after)
    if before_chars == 0:
        return {
            "chars_ratio": 1.0,
            "token_jaccard": 1.0,
            "drift_suspected": False,
        }
    chars_ratio = after_chars / before_chars
    before_tokens = set(before.lower().split())
    after_tokens = set(after.lower().split())
    union = before_tokens | after_tokens
    jaccard = len(before_tokens & after_tokens) / len(union) if union else 1.0
    drift = before_chars >= _DRIFT_MIN_BEFORE_CHARS and (chars_ratio < _DRIFT_THRESHOLD or jaccard < _DRIFT_THRESHOLD)
    return {
        "chars_ratio": round(chars_ratio, 3),
        "token_jaccard": round(jaccard, 3),
        "drift_suspected": drift,
    }


def persist(
    pages: list[CompiledPage],
    acquired: list[AcquiredSource],
    meta: VaultMetadata,
    pages_dir: Path,
    metadata_path: Path,
    log_dir: Path,
) -> Iterator[WikiPipelineEvent]:
    """Write each page, update vault metadata, append a compile-log entry."""
    total = len(pages)
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.PERSISTING,
        message=f"Persisting {total} page(s)",
        total=total,
    )

    now = datetime.now(timezone.utc).isoformat()

    log_entries: list[dict] = []
    for i, page in enumerate(pages, start=1):
        page_path = pages_dir / f"{page.slug}.md"
        before: str | None = None
        if page_path.exists():
            try:
                before = page_path.read_text()
            except OSError:
                before = None
        _atomic_write_text(page_path, page.markdown_body)

        meta.pages[page.slug] = PageMeta(
            slug=page.slug,
            title=page.title,
            one_line_summary=page.one_line_summary,
            source_shas=list(page.source_shas),
            last_updated=now,
            revision=page.revision,
            kind=page.kind,
        )

        # Drift signals only matter when there was a previous page body to
        # compare against. New pages get the default "no drift" entry.
        drift = (
            _drift_metrics(before, page.markdown_body)
            if before is not None
            else {"chars_ratio": 1.0, "token_jaccard": 1.0, "drift_suspected": False}
        )

        log_entries.append(
            {
                "slug": page.slug,
                "title": page.title,
                "revision": page.revision,
                "is_new": page.is_new,
                "before_chars": len(before) if before is not None else 0,
                "after_chars": len(page.markdown_body),
                "source_shas": list(page.source_shas),
                "before": before,
                "after": page.markdown_body,
                "chars_ratio": drift["chars_ratio"],
                "token_jaccard": drift["token_jaccard"],
                "drift_suspected": drift["drift_suspected"],
            }
        )
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_PROGRESS,
            phase=WikiPhase.PERSISTING,
            message=f"Wrote {page.slug}.md",
            current=i,
            total=total,
            file_name=page.slug,
        )
        if drift["drift_suspected"]:
            # Surface as a progress line (not error) so the modal stays open
            # on success but the log is auditable.
            yield WikiPipelineEvent(
                kind=WikiEventKind.STAGE_PROGRESS,
                phase=WikiPhase.PERSISTING,
                message=(
                    f"⚠ Drift suspected on {page.title} "
                    f"(chars {drift['chars_ratio']:.0%}, "
                    f"tokens {drift['token_jaccard']:.0%}) — review .compile-log/"
                ),
                current=i,
                total=total,
                file_name=page.slug,
            )

    # Update sources index.
    for src in acquired:
        contributed = [page.slug for page in pages if src.sha256 in page.source_shas]
        meta.sources[src.sha256] = IngestedSource(
            sha256=src.sha256,
            original_name=src.name,
            ingested_at=now,
            contributed_to=contributed,
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
                "pages": log_entries,
            },
            indent=2,
        )
    )

    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.PERSISTING,
        message=f"Persisted {total} page(s) to {pages_dir}",
        current=total,
        total=total,
    )
