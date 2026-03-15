"""Tests for the saving pipeline stage."""

from __future__ import annotations

from opentrace_agent.pipeline.saving import saving
from opentrace_agent.pipeline.store import MemoryStore
from opentrace_agent.pipeline.types import (
    EventKind,
    GraphNode,
    GraphRelationship,
    Phase,
    PipelineEvent,
)


def _mock_events() -> list[PipelineEvent]:
    return [
        PipelineEvent(
            kind=EventKind.STAGE_START,
            phase=Phase.SCANNING,
            message="Starting",
        ),
        PipelineEvent(
            kind=EventKind.STAGE_STOP,
            phase=Phase.SCANNING,
            message="Done scanning",
            nodes=[
                GraphNode(id="repo/file.py", type="File", name="file.py"),
                GraphNode(id="repo", type="Repository", name="repo"),
            ],
            relationships=[
                GraphRelationship(
                    id="rel-1",
                    type="DEFINED_IN",
                    source_id="repo/file.py",
                    target_id="repo",
                ),
            ],
        ),
        PipelineEvent(
            kind=EventKind.STAGE_PROGRESS,
            phase=Phase.PROCESSING,
            message="Processed file.py",
            nodes=[
                GraphNode(id="repo/file.py::Foo", type="Class", name="Foo"),
            ],
            relationships=[
                GraphRelationship(
                    id="rel-2",
                    type="DEFINED_IN",
                    source_id="repo/file.py::Foo",
                    target_id="repo/file.py",
                ),
            ],
        ),
    ]


def test_saving_persists_nodes() -> None:
    store = MemoryStore()
    events = list(saving(iter(_mock_events()), store))

    assert "repo/file.py" in store.nodes
    assert "repo" in store.nodes
    assert "repo/file.py::Foo" in store.nodes
    assert len(store.nodes) == 3


def test_saving_persists_relationships() -> None:
    store = MemoryStore()
    events = list(saving(iter(_mock_events()), store))

    assert "rel-1" in store.relationships
    assert "rel-2" in store.relationships
    assert len(store.relationships) == 2


def test_saving_reemits_all_events() -> None:
    store = MemoryStore()
    mock = _mock_events()
    events = list(saving(iter(mock), store))

    # All original events + 1 STAGE_STOP for SUBMITTING
    assert len(events) == len(mock) + 1
    assert events[-1].kind == EventKind.STAGE_STOP
    assert events[-1].phase == Phase.SUBMITTING


def test_saving_handles_events_without_data() -> None:
    """Events with no nodes/relationships pass through cleanly."""
    store = MemoryStore()
    mock = [
        PipelineEvent(
            kind=EventKind.STAGE_START,
            phase=Phase.SCANNING,
            message="Starting",
        ),
    ]
    events = list(saving(iter(mock), store))

    assert len(store.nodes) == 0
    assert len(store.relationships) == 0
    assert len(events) == 2  # original + SUBMITTING stop
