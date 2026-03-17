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
