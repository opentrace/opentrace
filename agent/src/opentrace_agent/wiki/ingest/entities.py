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

"""Entity wiring for the unified doc pass.

The single per-doc ``emit_page`` call now returns ``entities`` and ``edges``
alongside the summary + concept inventory (see ``doc_extraction.py``). This
module turns that into graph primitives — ``Idea``/``Service``/… nodes (each
carrying the new one-line ``description``), a ``DERIVED_FROM`` edge back to the
``CorpusDoc``, and ``SEMANTIC_EDGE`` entity↔entity edges — reusing the validation
in :func:`sources.markdown.extractor.parse_entities` and the entity-graph
conventions formerly housed in the standalone entity-extraction stage.
"""

from __future__ import annotations

from typing import Any

from opentrace_agent.pipeline.types import GraphNode, GraphRelationship
from opentrace_agent.sources.markdown.extractor import (
    _stem_from_uri as _stem_from_uri,
)
from opentrace_agent.sources.markdown.extractor import (
    entity_node_type,
    parse_entities,
)


def build_entities(
    result: dict,
    *,
    original_name: str,
    source_id: str,
    vault: str | None,
) -> tuple[list[GraphNode], list[GraphRelationship]]:
    """Build entity nodes + edges from one unified ``emit_page`` result.

    ``source_id`` is the ``corpus::<sha>`` CorpusDoc node the entities derive from;
    ``original_name`` seeds the deterministic ``{stem}_{entity}`` id so re-runs
    converge. Entity-entity ``edges`` reference entities by label — resolved to
    ids inside :func:`parse_entities`.
    """
    stem = _stem_from_uri(original_name)
    predicted = parse_entities(result, stem)

    entity_nodes: list[GraphNode] = []
    edges: list[GraphRelationship] = []
    for ent in predicted.entities:
        props: dict[str, Any] = {"derived_from": source_id}
        if ent.description:
            props["description"] = ent.description
        if vault:
            props["vault"] = vault
        entity_nodes.append(
            GraphNode(
                id=ent.id,
                type=entity_node_type(ent.type),
                name=ent.label,
                properties=props,
            )
        )
        edges.append(
            GraphRelationship(
                id=f"derived:{ent.id}->{source_id}",
                type="DERIVED_FROM",
                source_id=ent.id,
                target_id=source_id,
                properties={"transform": "llm_extraction"},
            )
        )

    for edge in predicted.edges:
        edge_props: dict[str, Any] = {
            "relation": edge.relation,
            "confidence": edge.confidence,
            "confidence_score": edge.confidence_score,
        }
        if vault:
            edge_props["vault"] = vault
        edges.append(
            GraphRelationship(
                id=f"se:{edge.source}:{edge.target}:{edge.relation}",
                type="SEMANTIC_EDGE",
                source_id=edge.source,
                target_id=edge.target,
                properties=edge_props,
            )
        )

    return entity_nodes, edges


def write_entity_nodes(store, nodes: list[GraphNode]) -> int:
    """Persist entity nodes only (no edges). Returns nodes written.

    Split from edge-writing because ``DERIVED_FROM`` edges point at
    ``CorpusDoc`` nodes that the vault mirror creates *later* —
    :func:`GraphStore.merge_relationship` silently drops an edge whose
    target node doesn't exist yet, so edges must be written after the
    vault mirror runs (see :func:`write_entity_edges`).
    """
    for n in nodes:
        store.add_node(id=n.id, node_type=n.type, name=n.name, properties=n.properties)
    return len(nodes)


def write_entity_edges(store, rels: list[GraphRelationship]) -> int:
    """Persist entity edges (``DERIVED_FROM`` + ``SEMANTIC_EDGE``). Returns
    edges written. Call *after* both the entity nodes and their
    ``DERIVED_FROM`` targets (CorpusDoc nodes, created by the vault mirror)
    exist, or the edges are silently dropped."""
    for r in rels:
        store.merge_relationship(
            id=r.id,
            rel_type=r.type,
            source_id=r.source_id,
            target_id=r.target_id,
            properties=r.properties,
        )
    return len(rels)


def write_entities_to_graph(store, nodes: list[GraphNode], rels: list[GraphRelationship]) -> int:
    """Persist merged entity nodes + edges via the GraphStore mirror API.

    Convenience wrapper for callers where all edge targets already exist.
    The vault pipeline instead interleaves :func:`write_entity_nodes`
    (before the vault mirror, so its MENTIONS pass sees the entities) and
    :func:`write_entity_edges` (after, so DERIVED_FROM targets exist).
    Returns nodes written.
    """
    write_entity_nodes(store, nodes)
    write_entity_edges(store, rels)
    return len(nodes)
