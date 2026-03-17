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

"""Generator-based indexing pipeline with streaming events."""

from opentrace_agent.pipeline.pipeline import (
    collect_pipeline,
    core_pipeline,
    run_pipeline,
)
from opentrace_agent.pipeline.store import MemoryStore, Store
from opentrace_agent.pipeline.types import (
    CallInfo,
    EventKind,
    FileEntry,
    GraphNode,
    GraphRelationship,
    Phase,
    PipelineContext,
    PipelineEvent,
    PipelineInput,
    PipelineResult,
    ProcessingOutput,
    Registries,
    ScanResult,
    StageResult,
    SymbolInfo,
)

__all__ = [
    "CallInfo",
    "EventKind",
    "FileEntry",
    "GraphNode",
    "GraphRelationship",
    "MemoryStore",
    "Phase",
    "PipelineContext",
    "PipelineEvent",
    "PipelineInput",
    "PipelineResult",
    "ProcessingOutput",
    "Registries",
    "ScanResult",
    "StageResult",
    "Store",
    "SymbolInfo",
    "collect_pipeline",
    "core_pipeline",
    "run_pipeline",
]
