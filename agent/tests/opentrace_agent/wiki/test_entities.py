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

from opentrace_agent.sources.markdown.extractor import parse_entities
from opentrace_agent.sources.markdown.prompts import make_entity_id
from opentrace_agent.wiki.ingest.entities import build_entities


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
