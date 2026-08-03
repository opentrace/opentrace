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

"""Wiki pipeline types — events, phases, and the structured Plan schema."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class WikiPhase(str, Enum):
    ACQUIRING = "acquiring"
    NORMALIZING = "normalizing"
    EXTRACTING = "extracting"
    PLANNING = "planning"
    EXECUTING = "executing"
    PERSISTING = "persisting"


# String constant used for ``CompiledPage.kind`` and ``PageMeta.kind``.
# Plain string so it JSON-serializes trivially in ``.vault.json``. Concept
# pages are the only page kind — per-document content is represented by
# ``Source`` nodes (label + corpus body), not wiki pages.
PAGE_KIND_CONCEPT = "concept"


class WikiEventKind(str, Enum):
    STAGE_START = "stage_start"
    STAGE_PROGRESS = "stage_progress"
    STAGE_STOP = "stage_stop"
    DONE = "done"
    ERROR = "error"


@dataclass(frozen=True)
class WikiPipelineEvent:
    kind: WikiEventKind
    phase: WikiPhase
    message: str
    current: int = 0
    total: int = 0
    file_name: str | None = None
    detail: dict[str, Any] | None = None
    errors: list[str] | None = None


@dataclass
class SourceInput:
    """A file submitted for compilation (data + display name)."""

    name: str
    data: bytes
    # Epistemic status: "authoritative" (current documentation, the default),
    # "design_history" (proposals/specs/ADRs — intent, not behaviour), or
    # "design_history_archived". Stamped by classify_doc_status on repo walks;
    # synthesis ranks conflicting sources by it.
    status: str = "authoritative"


@dataclass
class NormalizedSource:
    sha256: str
    original_name: str
    markdown: str
    # Populated after the corpus-write step (only when a graph store is
    # attached). Relative to the .opentrace/ dir containing the graph DB,
    # so the value stays portable across machines.
    corpus_path: str | None = None
    # Navigation label, stamped by the DocExtraction stage and copied onto
    # the Source node by the graph writer: a display title derived from the
    # filename plus the LLM's one-sentence description of the document.
    title: str = ""
    one_line_summary: str = ""
    # Epistemic status, carried from SourceInput (see there).
    status: str = "authoritative"







@dataclass
class CompiledPage:
    slug: str
    title: str
    markdown_body: str
    one_line_summary: str
    source_shas: list[str]
    revision: int
    is_new: bool
    kind: str = PAGE_KIND_CONCEPT


def _wiki_concurrency() -> int:
    """Worker count for the parallel per-doc extraction loop.

    ``OT_WIKI_CONCURRENCY`` overrides the default of 8; always at least 1.
    8 suits a healthy paid API tier; WikiLLM's retry/backoff absorbs the extra
    429s a lower tier may see — drop it if throttled.
    """
    import os

    raw = os.environ.get("OT_WIKI_CONCURRENCY", "").strip()
    try:
        return max(1, int(raw)) if raw else 8
    except ValueError:
        return 8
