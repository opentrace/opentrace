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
    SUMMARIZING_SOURCES = "summarizing_sources"
    PLANNING = "planning"
    EXECUTING = "executing"
    PERSISTING = "persisting"


# String constants used for ``CompiledPage.kind`` and ``PageMeta.kind``.
# Plain strings so they JSON-serialize trivially in ``.vault.json``.
#
# ``PAGE_KIND_SOURCE_SUMMARY`` replaces an older ``"source"`` value; vaults
# written before this rename are migrated transparently when their
# ``.vault.json`` is loaded (see ``vault.PageMeta.from_json``).
PAGE_KIND_SOURCE_SUMMARY = "source_summary"
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


@dataclass
class NormalizedSource:
    sha256: str
    original_name: str
    markdown: str


@dataclass
class PlanCreate:
    title: str
    source_shas: list[str]
    rationale: str = ""


@dataclass
class PlanExtend:
    page_slug: str
    source_shas: list[str]
    rationale: str = ""


@dataclass
class Plan:
    creates: list[PlanCreate] = field(default_factory=list)
    extends: list[PlanExtend] = field(default_factory=list)


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


class VaultIndexTooLarge(RuntimeError):
    """Raised when the vault index is too big to fit in a Plan call."""
