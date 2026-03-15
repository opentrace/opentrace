"""Stage 4: Saving — intercepts pipeline events and persists to a Store."""

from __future__ import annotations

from typing import Generator

from opentrace_agent.pipeline.store import Store
from opentrace_agent.pipeline.types import (
    EventKind,
    Phase,
    PipelineEvent,
)


def saving(
    inner: Generator[PipelineEvent, None, None],
    store: Store,
) -> Generator[PipelineEvent, None, None]:
    """Wrap an inner generator, persisting nodes/relationships as they flow through."""
    nodes_saved = 0
    rels_saved = 0

    for event in inner:
        if event.nodes:
            for node in event.nodes:
                store.save_node(node)
            nodes_saved += len(event.nodes)
        if event.relationships:
            for rel in event.relationships:
                store.save_relationship(rel)
            rels_saved += len(event.relationships)
        yield event

    store.flush()
    yield PipelineEvent(
        kind=EventKind.STAGE_STOP,
        phase=Phase.SUBMITTING,
        message=f"Saved {nodes_saved} nodes, {rels_saved} relationships",
    )
