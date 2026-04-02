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

"""Pipeline type definitions — events, stages, graph primitives, and StageResult."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Generic, TypeVar

T = TypeVar("T")


class Phase(str, Enum):
    SCANNING = "scanning"
    PROCESSING = "processing"
    RESOLVING = "resolving"
    SUBMITTING = "submitting"


class EventKind(str, Enum):
    STAGE_START = "stage_start"
    STAGE_PROGRESS = "stage_progress"
    STAGE_STOP = "stage_stop"
    DONE = "done"
    ERROR = "error"


@dataclass(frozen=True)
class GraphNode:
    id: str
    type: str
    name: str
    properties: dict[str, Any] | None = None


@dataclass(frozen=True)
class GraphRelationship:
    id: str
    type: str
    source_id: str
    target_id: str
    properties: dict[str, Any] | None = None


@dataclass(frozen=True)
class ProgressDetail:
    current: int
    total: int
    file_name: str | None = None


@dataclass(frozen=True)
class PipelineEvent:
    kind: EventKind
    phase: Phase
    message: str
    detail: ProgressDetail | None = None
    nodes: list[GraphNode] | None = None
    relationships: list[GraphRelationship] | None = None
    result: PipelineResult | None = None
    errors: list[str] | None = None


@dataclass
class PipelineInput:
    path: str | None = None
    repo_url: str | None = None
    repo_id: str | None = None
    ref: str | None = None
    provider: str | None = None


@dataclass
class PipelineContext:
    cancelled: bool = False


@dataclass
class PipelineResult:
    nodes_created: int = 0
    relationships_created: int = 0
    files_processed: int = 0
    classes_extracted: int = 0
    functions_extracted: int = 0
    variables_extracted: int = 0
    derivations_resolved: int = 0
    errors: list[str] = field(default_factory=list)


@dataclass
class StageResult(Generic[T]):
    value: T | None = None


# --- Stage boundary types ---


@dataclass
class FileEntry:
    """A parseable file discovered during scanning."""

    file_id: str
    abs_path: str
    path: str  # repo-relative
    extension: str
    language: str | None


@dataclass
class ScanResult:
    """Output of the scanning stage."""

    repo_id: str
    root_path: str
    structural_nodes: list[GraphNode] = field(default_factory=list)
    structural_relationships: list[GraphRelationship] = field(default_factory=list)
    file_entries: list[FileEntry] = field(default_factory=list)
    known_paths: set[str] = field(default_factory=set)
    path_to_file_id: dict[str, str] = field(default_factory=dict)
    go_module_path: str | None = None
    repo_url: str | None = None
    ref: str | None = None
    provider: str | None = None


@dataclass
class SymbolInfo:
    """Flattened info about an extracted symbol for registry use."""

    node_id: str
    name: str
    kind: str  # "class" or "function"
    file_id: str
    language: str
    receiver_var: str | None = None
    receiver_type: str | None = None
    param_types: dict[str, str] | None = None
    children: list[SymbolInfo] = field(default_factory=list)


@dataclass
class CallInfo:
    """A pending call reference to resolve."""

    caller_id: str
    caller_name: str
    file_id: str
    calls: list[tuple[str, str | None, str]]  # (name, receiver, kind)
    receiver_var: str | None = None
    receiver_type: str | None = None
    param_types: dict[str, str] | None = None


@dataclass
class DerivationInfo:
    """A pending derivation reference to resolve."""

    variable_id: str
    scope_id: str
    file_id: str
    refs: list[tuple[str, str | None, str]]  # (name, receiver, kind)


@dataclass
class Registries:
    """Global registries populated during processing, consumed during resolving."""

    name_registry: dict[str, list[SymbolInfo]] = field(default_factory=dict)
    file_registry: dict[str, dict[str, SymbolInfo]] = field(default_factory=dict)
    class_registry: dict[str, list[SymbolInfo]] = field(default_factory=dict)
    import_registry: dict[str, dict[str, str]] = field(default_factory=dict)
    variable_registry: dict[str, dict[str, str]] = field(default_factory=dict)
    """scope_id → {variable_name → variable_node_id}"""


@dataclass
class ProcessingOutput:
    """Output of the processing stage."""

    registries: Registries = field(default_factory=Registries)
    call_infos: list[CallInfo] = field(default_factory=list)
    derivation_infos: list[DerivationInfo] = field(default_factory=list)
    nodes_created: int = 0
    relationships_created: int = 0
    files_processed: int = 0
    classes_extracted: int = 0
    functions_extracted: int = 0
    variables_extracted: int = 0
    errors: list[str] = field(default_factory=list)
