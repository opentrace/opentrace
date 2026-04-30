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

"""Normalize stage — convert raw source bytes to markdown text via markitdown."""

from __future__ import annotations

import io
import os
import tempfile
from collections.abc import Iterable, Iterator

from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.ingest.types import (
    NormalizedSource,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)


_PASSTHROUGH_EXTS = {".md", ".markdown", ".txt"}


def _is_passthrough(name: str) -> bool:
    lower = name.lower()
    return any(lower.endswith(ext) for ext in _PASSTHROUGH_EXTS)


def _passthrough(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def _markitdown_convert(name: str, data: bytes) -> str:
    """Convert non-text formats via the markitdown library (lazy-imported)."""
    try:
        from markitdown import MarkItDown
    except ImportError as e:
        raise RuntimeError("markitdown is required for non-text sources — install with: uv add markitdown") from e

    md = MarkItDown()

    # markitdown's BinaryIO API takes a stream; provide one with a name attr so
    # extension sniffing works.
    suffix = os.path.splitext(name)[1] or ""
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        result = md.convert(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    return result.text_content or ""


def normalize(
    sources: Iterable[AcquiredSource],
    out: list[NormalizedSource],
) -> Iterator[WikiPipelineEvent]:
    """Convert each acquired source to markdown text. Errors drop the single source."""
    items = list(sources)
    total = len(items)
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.NORMALIZING,
        message=f"Normalizing {total} source(s)",
        total=total,
    )
    errors: list[str] = []
    for i, src in enumerate(items, start=1):
        try:
            if _is_passthrough(src.name):
                text = _passthrough(src.data)
            else:
                text = _markitdown_convert(src.name, src.data)
        except Exception as e:
            err = f"normalize failed for {src.name}: {e}"
            errors.append(err)
            yield WikiPipelineEvent(
                kind=WikiEventKind.ERROR,
                phase=WikiPhase.NORMALIZING,
                message=err,
                current=i,
                total=total,
                file_name=src.name,
                errors=[err],
            )
            continue
        out.append(NormalizedSource(sha256=src.sha256, original_name=src.name, markdown=text))
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_PROGRESS,
            phase=WikiPhase.NORMALIZING,
            message=f"Normalized {src.name}",
            current=i,
            total=total,
            file_name=src.name,
        )
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.NORMALIZING,
        message=f"Normalized {len(out)} of {total}",
        current=total,
        total=total,
        errors=errors or None,
    )


# Re-export for tests that want to swap the normalizer.
__all__ = ["normalize", "_passthrough", "_markitdown_convert", "_is_passthrough"]


# Silence unused-import warnings; io kept for mypy stub compatibility.
_ = io
