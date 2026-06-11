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

"""Markdown ingestion via Microsoft's ``markitdown``.

One entry point: ``convert(path_or_url)`` returns an ``AnnotatedMarkdown`` —
markdown text plus YAML-style frontmatter recording where it came from. The
loader covers ~10 source types in v1: PDF, Word, PowerPoint, EPub, HTML
(static + arXiv), Excel/CSV/JSON, Image (OCR + optional LLM description),
YouTube, Audio, generic Video.

The fetcher layer (``fetchers.py``) is responsible for resolving a URL into
something markitdown understands. This module focuses on the conversion +
provenance bookkeeping; downstream LLM extraction (a later step) consumes
the ``AnnotatedMarkdown.markdown`` field.

Single LLM-extraction prompt downstream regardless of source type — the
shape that comes out of here is the same for PDFs and audio transcripts.
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Source-type detection
# ---------------------------------------------------------------------------


# Map file extension → canonical source type. Extension match wins over URL
# heuristics so a local ``.pdf`` is always called a PDF, even if someone
# named it ``http_pdf.pdf``.
_EXT_TO_TYPE: dict[str, str] = {
    ".pdf": "pdf",
    ".docx": "word",
    ".doc": "word",
    ".pptx": "powerpoint",
    ".ppt": "powerpoint",
    ".xlsx": "excel",
    ".xls": "excel",
    ".csv": "csv",
    ".json": "json",
    ".xml": "xml",
    ".epub": "epub",
    ".html": "html",
    ".htm": "html",
    ".md": "markdown",
    ".markdown": "markdown",
    ".txt": "text",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".mp3": "audio",
    ".wav": "audio",
    ".m4a": "audio",
    ".mp4": "video",
    ".mov": "video",
    ".webm": "video",
    ".mkv": "video",
}


def detect_source_type(path_or_url: str) -> str:
    """Heuristic: classify input into a stable ``source_type`` token.

    Extension-driven for paths; URL-host-driven for the live web (arXiv,
    YouTube). Falls back to "unknown" when nothing matches — callers should
    treat that the same as "html" or "text" but log the fact.
    """
    parsed = urlparse(path_or_url)
    if parsed.scheme in ("http", "https"):
        host = (parsed.netloc or "").lower()
        if host.endswith("arxiv.org"):
            return "arxiv"
        if "youtube.com" in host or host == "youtu.be":
            return "youtube"
        # Extension hint inside the URL path takes priority over generic html.
        ext = Path(parsed.path).suffix.lower()
        if ext in _EXT_TO_TYPE:
            return _EXT_TO_TYPE[ext]
        return "html"
    # Local file path
    ext = Path(path_or_url).suffix.lower()
    return _EXT_TO_TYPE.get(ext, "unknown")


# ---------------------------------------------------------------------------
# Result shape
# ---------------------------------------------------------------------------


@dataclass
class AnnotatedMarkdown:
    """Markitdown output enriched with provenance for downstream extraction."""

    markdown: str
    source_uri: str
    source_type: str
    title: str | None = None
    fetched_at: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def with_frontmatter(self) -> str:
        """Return the markdown with a YAML frontmatter header prepended."""
        lines = ["---"]
        lines.append(f'source_uri: "{_yaml_escape(self.source_uri)}"')
        lines.append(f"source_type: {self.source_type}")
        if self.title:
            lines.append(f'title: "{_yaml_escape(self.title)}"')
        if self.fetched_at:
            lines.append(f"fetched_at: {self.fetched_at}")
        for k, v in self.metadata.items():
            # Only stringify primitives in the header — complex metadata stays
            # in the dataclass and never leaks into the LLM-visible body.
            if isinstance(v, (str, int, float, bool)):
                lines.append(f'{k}: "{_yaml_escape(str(v))}"')
        lines.append("---")
        lines.append("")
        lines.append(self.markdown)
        return "\n".join(lines)


def _yaml_escape(s: str) -> str:
    """Escape a string for safe inclusion in double-quoted YAML."""
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------


_INSTALL_HINT = "markitdown not installed. Run: uv pip install 'opentraceai[graph]'"


def _import_markitdown():
    try:
        from markitdown import MarkItDown  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(_INSTALL_HINT) from exc
    return MarkItDown


# A fresh MarkItDown() registers every converter and spins up native (onnx /
# BLAS) thread pools; constructing one per file under a thread pool was
# exploding the thread count. Reuse a single instance per thread for the common
# no-LLM path — thread-local keeps it safe without assuming MarkItDown is
# concurrency-safe. The LLM-enabled path still builds per call (rare, and the
# client/model vary).
_tls = threading.local()


def _shared_markitdown():
    inst = getattr(_tls, "markitdown", None)
    if inst is None:
        inst = _import_markitdown()()
        _tls.markitdown = inst
    return inst


def convert(
    path_or_url: str,
    *,
    llm_client: Any = None,
    llm_model: str | None = None,
) -> AnnotatedMarkdown:
    """Convert anything markitdown can read into ``AnnotatedMarkdown``.

    Pass ``llm_client``+``llm_model`` to enable image description / OCR. The
    pair is forwarded to markitdown unchanged — see its docs for supported
    client interfaces (OpenAI-compatible).
    """
    # Surface a clear "not installed" error before touching any cached instance.
    _import_markitdown()
    source_type = detect_source_type(path_or_url)
    if llm_client is None and llm_model is None:
        # Common path (no image OCR/description) — reuse the per-thread instance.
        md = _shared_markitdown()
    else:
        kwargs: dict[str, Any] = {}
        if llm_client is not None:
            kwargs["llm_client"] = llm_client
        if llm_model is not None:
            kwargs["llm_model"] = llm_model
        md = _import_markitdown()(**kwargs)

    if _is_url(path_or_url):
        result = md.convert_url(path_or_url)
    else:
        result = md.convert(path_or_url)

    text = getattr(result, "markdown", None) or getattr(result, "text_content", "")
    title = getattr(result, "title", None)
    return AnnotatedMarkdown(
        markdown=text,
        source_uri=path_or_url,
        source_type=source_type,
        title=title,
        fetched_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )


def _is_url(path_or_url: str) -> bool:
    parsed = urlparse(path_or_url)
    return parsed.scheme in ("http", "https", "file")
