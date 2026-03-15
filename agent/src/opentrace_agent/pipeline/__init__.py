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
