"""Store protocol and in-memory implementation for pipeline persistence."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from opentrace_agent.pipeline.types import GraphNode, GraphRelationship


@runtime_checkable
class Store(Protocol):
    def save_node(self, node: GraphNode) -> None: ...
    def save_relationship(self, rel: GraphRelationship) -> None: ...
    def flush(self) -> None: ...


class MemoryStore:
    """In-memory store for testing."""

    def __init__(self) -> None:
        self.nodes: dict[str, GraphNode] = {}
        self.relationships: dict[str, GraphRelationship] = {}

    def save_node(self, node: GraphNode) -> None:
        self.nodes[node.id] = node

    def save_relationship(self, rel: GraphRelationship) -> None:
        self.relationships[rel.id] = rel

    def flush(self) -> None:
        pass
