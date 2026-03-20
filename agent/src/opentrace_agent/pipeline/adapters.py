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

"""Store adapter wrapping GraphStore to conform to the pipeline Store protocol."""

from __future__ import annotations

import logging
from typing import Any

from opentrace_agent.pipeline.types import GraphNode, GraphRelationship

logger = logging.getLogger(__name__)


def _node_to_dict(node: GraphNode) -> dict[str, Any]:
    return {
        "id": node.id,
        "type": node.type,
        "name": node.name,
        "properties": node.properties or {},
    }


def _rel_to_dict(rel: GraphRelationship) -> dict[str, Any]:
    return {
        "id": rel.id,
        "type": rel.type,
        "source_id": rel.source_id,
        "target_id": rel.target_id,
        "properties": rel.properties or {},
    }


class GraphStoreAdapter:
    """Wraps GraphStore to conform to the pipeline Store protocol.

    Accumulates nodes/relationships and flushes in batches.
    Nodes are always flushed before relationships since rels
    reference nodes via MATCH.
    """

    def __init__(self, graph_store: Any, batch_size: int = 200) -> None:
        self._store = graph_store
        self._batch_size = batch_size
        self._nodes: list[dict[str, Any]] = []
        self._rels: list[dict[str, Any]] = []

    def save_node(self, node: GraphNode) -> None:
        self._nodes.append(_node_to_dict(node))
        if len(self._nodes) >= self._batch_size:
            self._flush_nodes()

    def save_relationship(self, rel: GraphRelationship) -> None:
        self._rels.append(_rel_to_dict(rel))
        if len(self._rels) >= self._batch_size:
            self._flush_rels()

    def flush(self) -> None:
        self._flush_nodes()
        self._flush_rels()

    def close(self) -> None:
        self.flush()
        self._store.close()

    def _flush_nodes(self) -> None:
        if not self._nodes:
            return
        result = self._store.import_batch(self._nodes, [])
        if result["errors"]:
            logger.warning("Batch node import had %d errors", result["errors"])
        self._nodes.clear()

    def _flush_rels(self) -> None:
        if not self._rels:
            return
        result = self._store.import_batch([], self._rels)
        if result["errors"]:
            logger.warning("Batch rel import had %d errors", result["errors"])
        self._rels.clear()
