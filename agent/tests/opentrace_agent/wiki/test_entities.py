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

"""Tests for the unified doc pass's entity wiring (build_entities) and the
shared extraction validation (parse_entities)."""

from __future__ import annotations

import pytest

from opentrace_agent.sources.markdown.extractor import parse_entities
from opentrace_agent.sources.markdown.prompts import make_entity_id
from opentrace_agent.wiki.ingest.entities import (
    build_entities,
    write_entities_to_graph,
    write_entity_edges,
    write_entity_nodes,
)


class TestBuildEntities:
    def test_nodes_edges_description_and_label_resolution(self):
        result = {
            "entities": [
                {"label": "Validation", "type": "idea", "description": "checking inputs"},
                {"label": "Karen", "type": "person", "description": "a developer"},
            ],
            "edges": [
                {
                    "source": "Karen",
                    "target": "Validation",
                    "relation": "wrote",
                    "confidence": "EXTRACTED",
                    "confidence_score": 1.0,
                }
            ],
        }
        nodes, edges = build_entities(result, original_name="doc.md", source_id="corpus::abc", vault="v")

        by_id = {n.id: n for n in nodes}
        vid = make_entity_id("doc", "Validation")
        kid = make_entity_id("doc", "Karen")
        assert by_id[vid].type == "Idea"
        assert by_id[vid].properties["description"] == "checking inputs"
        assert by_id[vid].properties["derived_from"] == "corpus::abc"
        assert by_id[vid].properties["vault"] == "v"
        assert by_id[kid].type == "Person"

        derived = [e for e in edges if e.type == "DERIVED_FROM"]
        assert {e.source_id for e in derived} == {vid, kid}
        assert all(e.target_id == "corpus::abc" for e in derived)

        semantic = [e for e in edges if e.type == "SEMANTIC_EDGE"]
        assert len(semantic) == 1
        # Edge endpoints were given as labels; resolved to entity ids.
        assert semantic[0].source_id == kid and semantic[0].target_id == vid
        assert semantic[0].properties["relation"] == "wrote"

    def test_no_entities_yields_nothing(self):
        assert build_entities({}, original_name="x.md", source_id="corpus::s", vault=None) == ([], [])
        assert build_entities({"entities": []}, original_name="x.md", source_id="corpus::s", vault=None) == ([], [])


pytest.importorskip("real_ladybug")
from opentrace_agent.store import GraphStore  # noqa: E402


class TestEntityWriteOrdering:
    """Regression: DERIVED_FROM points at CorpusDoc nodes the vault mirror
    creates later, and merge_relationship silently drops edges to a missing
    target. So entity NODES must be written before the mirror (for MENTIONS)
    and entity EDGES after it (so the DERIVED_FROM target exists)."""

    def _store(self, tmp_path):
        return GraphStore(str(tmp_path / "e.db"))

    def _derived_from_count(self, store):
        r = store._conn.execute("MATCH ()-[r:RELATES]->() WHERE r.type='DERIVED_FROM' RETURN count(*)")
        return r.get_next()[0]

    def test_edges_dropped_when_target_missing(self, tmp_path):
        """Documents the failure mode: all-in-one write loses DERIVED_FROM
        because the CorpusDoc target doesn't exist yet."""
        store = self._store(tmp_path)
        nodes, rels = build_entities(
            {"entities": [{"label": "Werkzeug", "type": "Service"}]},
            original_name="r.md",
            source_id="corpus::abc",
            vault="v",
        )
        write_entities_to_graph(store, nodes, rels)  # corpus::abc absent
        assert self._derived_from_count(store) == 0
        store.close()

    def test_split_write_preserves_derived_from(self, tmp_path):
        """The pipeline's node-first / mirror / edges-last order keeps it."""
        store = self._store(tmp_path)
        nodes, rels = build_entities(
            {"entities": [{"label": "Werkzeug", "type": "Service"}]},
            original_name="r.md",
            source_id="corpus::abc",
            vault="v",
        )
        write_entity_nodes(store, nodes)
        store.add_node(id="corpus::abc", node_type="KnowledgeDoc", name="r.md", properties={})
        write_entity_edges(store, rels)
        assert self._derived_from_count(store) == 1
        inc = store.traverse("corpus::abc", direction="incoming", max_depth=1, relationship_type="DERIVED_FROM")
        assert [r["node"]["id"] for r in inc] == [nodes[0].id]
        store.close()


class TestParseEntities:
    def test_lowercases_type_and_keeps_description(self):
        pred = parse_entities({"entities": [{"label": "X", "type": "PAPER", "description": "a ref"}]}, "doc")
        assert pred.entities[0].type == "paper"
        assert pred.entities[0].description == "a ref"

    def test_drops_dangling_edge_and_snaps_confidence(self):
        result = {
            "entities": [
                {"label": "A", "type": "service", "description": "d"},
                {"label": "B", "type": "module", "description": "d"},
            ],
            "edges": [
                # target not in the entity set → dropped.
                {"source": "A", "target": "Ghost", "relation": "x", "confidence": "EXTRACTED"},
                # 0.99 isn't a legal INFERRED score → snapped to the nearest (0.95).
                {"source": "A", "target": "B", "relation": "uses", "confidence": "INFERRED", "confidence_score": 0.99},
            ],
        }
        pred = parse_entities(result, "doc")
        assert len(pred.entities) == 2
        assert len(pred.edges) == 1
        assert pred.edges[0].relation == "uses"
        assert pred.edges[0].confidence_score == 0.95

    def test_skips_entities_without_label(self):
        pred = parse_entities({"entities": ["junk", {"type": "idea"}, {"label": "Real", "type": "idea"}]}, "doc")
        assert [e.label for e in pred.entities] == ["Real"]
