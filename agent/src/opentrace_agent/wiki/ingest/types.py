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
class PlanCreate:
    title: str
    source_shas: list[str]
    rationale: str = ""
    # Sub-topics this page absorbs, written as sections (not separate pages).
    sections: list[str] = field(default_factory=list)
    # Subset of source_shas added by the plan-time relevance scan (not the
    # concept clusterer) — marked as supplementary in the synthesis prompt.
    augmented_shas: list[str] = field(default_factory=list)


@dataclass
class PlanExtend:
    page_slug: str
    source_shas: list[str]
    rationale: str = ""
    sections: list[str] = field(default_factory=list)
    augmented_shas: list[str] = field(default_factory=list)


@dataclass
class Plan:
    creates: list[PlanCreate] = field(default_factory=list)
    extends: list[PlanExtend] = field(default_factory=list)


@dataclass
class ConceptMention:
    """A single concept noted in one source document (the Map stage output).

    Concepts are qualified by ``(topic, subject)``: ``topic`` is the recurring
    subject matter ("validation", "security"), ``subject`` is the real-world
    entity the concept is a property *of* ("pydantic", "Acme Software") — the
    product/system being documented, not the file it appears in. The Resolve
    stage clusters mentions, merging only when BOTH match.
    """

    topic: str
    subject: str
    gloss: str  # one line: what THIS document says about the concept
    source_sha: str


@dataclass
class ResolvedConcept:
    """A concept cluster surviving Resolve — becomes one concept page.

    ``source_shas`` is the union of every document whose mention joined this
    cluster (across all its sections), so the synthesis stage knows which
    sources to draw across. ``sections`` is the outline of finer sub-topics this
    page absorbs — each is written as a section of the one page rather than its
    own page, so nothing is dropped, just placed at the right level.
    """

    title: str  # canonical, subject-qualified when needed ("Security of Acme")
    topic: str
    subject: str
    source_shas: list[str]
    rationale: str = ""
    sections: list[str] = field(default_factory=list)


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
