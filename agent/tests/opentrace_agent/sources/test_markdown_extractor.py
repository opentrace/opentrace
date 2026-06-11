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

"""Tests for the LLM extractor scaffolding.

We use deterministic stub clients here — no real LLM calls. Prompt quality
is measured by the eval harness (``opentraceai-bench llm-extraction-eval``),
not by these unit tests.
"""

from __future__ import annotations

import json

from opentrace_agent.benchmarks.llm_extraction_eval import PredictedEntity
from opentrace_agent.sources.markdown import (
    AnnotatedMarkdown,
    ExtractionStats,
    extract_entities,
    make_entity_id,
    propose_hyperedges,
    propose_semantic_edges,
    round_confidence,
)


class StubClient:
    """Deterministic LLM stand-in for tests.

    Returns whatever string was supplied to ``respond_with()``. Records each
    (system, user) pair so tests can assert on the prompts that fired.
    """

    def __init__(self, response: str = ""):
        self.response = response
        self.calls: list[tuple[str, str]] = []

    def complete(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        return self.response


def _annotated(markdown: str) -> AnnotatedMarkdown:
    return AnnotatedMarkdown(
        markdown=markdown,
        source_uri="/tmp/doc.md",
        source_type="markdown",
    )


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestMakeEntityId:
    def test_lowercase_alnum_only(self):
        # ``stem`` is expected pre-stripped of extension by the caller;
        # ``make_entity_id`` itself just normalises both arguments.
        assert make_entity_id("Auth", "Login Service") == "auth_login_service"

    def test_strips_consecutive_separators(self):
        assert make_entity_id("Foo  Bar", "X / Y") == "foo_bar_x_y"

    def test_empty_inputs_fall_back(self):
        assert make_entity_id("", "") == "doc_entity"


class TestRoundConfidence:
    def test_extracted_always_one(self):
        assert round_confidence("EXTRACTED", 0.7) == 1.0

    def test_inferred_snaps_to_nearest_band(self):
        # 0.62 → 0.65 (closest allowed value)
        assert round_confidence("INFERRED", 0.62) == 0.65
        assert round_confidence("INFERRED", 0.5) == 0.55  # never returns 0.5

    def test_ambiguous_snaps_to_band(self):
        assert round_confidence("AMBIGUOUS", 0.18) == 0.2

    def test_unknown_tier_returns_zero(self):
        assert round_confidence("WEIRD", 0.5) == 0.0


# ---------------------------------------------------------------------------
# extract_entities
# ---------------------------------------------------------------------------


class TestExtractEntities:
    def test_happy_path(self):
        client = StubClient(
            json.dumps(
                {
                    "entities": [
                        {"id": "anything", "label": "Login Service", "type": "service"},
                        {"id": "ignored", "label": "Session Token", "type": "concept"},
                    ],
                    "edges": [
                        {
                            "source": "anything",
                            "target": "ignored",
                            "relation": "issues",
                            "confidence": "EXTRACTED",
                            "confidence_score": 1.0,
                        }
                    ],
                }
            )
        )
        result = extract_entities(_annotated("# Doc\nbody"), client)
        assert len(result.entities) == 2
        # IDs are recomputed deterministically; the model-supplied IDs are remapped.
        ids = {e.id for e in result.entities}
        assert ids == {"doc_login_service", "doc_session_token"}
        # Edge endpoints were remapped to canonical IDs.
        assert len(result.edges) == 1
        edge = result.edges[0]
        assert edge.source == "doc_login_service"
        assert edge.target == "doc_session_token"
        assert edge.confidence == "EXTRACTED"
        assert edge.confidence_score == 1.0

    def test_invalid_json_returns_empty(self):
        client = StubClient("not json at all")
        stats = ExtractionStats()
        result = extract_entities(_annotated("doc"), client, stats=stats)
        assert result.entities == []
        assert result.edges == []
        assert stats.hollow_responses == 1

    def test_strips_markdown_fence(self):
        client = StubClient('```json\n{"entities":[{"label":"X","type":"concept"}],"edges":[]}\n```')
        result = extract_entities(_annotated("doc"), client)
        assert len(result.entities) == 1
        assert result.entities[0].label == "X"

    def test_drops_entities_without_label(self):
        client = StubClient(
            json.dumps(
                {
                    "entities": [
                        {"id": "valid", "label": "Real"},
                        {"id": "nolabel"},  # missing label → dropped
                        {"label": ""},  # empty label → dropped
                    ],
                    "edges": [],
                }
            )
        )
        stats = ExtractionStats()
        result = extract_entities(_annotated("d"), client, stats=stats)
        assert len(result.entities) == 1
        assert stats.invalid_entities == 2

    def test_drops_edges_with_unknown_endpoints(self):
        client = StubClient(
            json.dumps(
                {
                    "entities": [{"id": "a", "label": "A"}],
                    "edges": [
                        # source=ghost is invalid; target is valid.
                        {
                            "source": "ghost",
                            "target": "a",
                            "relation": "x",
                            "confidence": "EXTRACTED",
                            "confidence_score": 1.0,
                        },
                    ],
                }
            )
        )
        stats = ExtractionStats()
        result = extract_entities(_annotated("d"), client, stats=stats)
        assert result.edges == []
        assert stats.invalid_edges == 1

    def test_snaps_confidence_score(self):
        client = StubClient(
            json.dumps(
                {
                    "entities": [
                        {"id": "a", "label": "A"},
                        {"id": "b", "label": "B"},
                    ],
                    "edges": [
                        {
                            "source": "a",
                            "target": "b",
                            "relation": "x",
                            "confidence": "INFERRED",
                            # Model drifted to 0.5 — must NOT survive into output.
                            "confidence_score": 0.5,
                        },
                    ],
                }
            )
        )
        result = extract_entities(_annotated("d"), client)
        assert result.edges[0].confidence_score == 0.55  # nearest legal


# ---------------------------------------------------------------------------
# propose_semantic_edges
# ---------------------------------------------------------------------------


class TestProposeSemanticEdges:
    def _nodes(self):
        return [
            PredictedEntity(id="a", label="A"),
            PredictedEntity(id="b", label="B"),
            PredictedEntity(id="c", label="C"),
        ]

    def test_drops_hallucinated_endpoints(self):
        client = StubClient(
            json.dumps(
                {
                    "edges": [
                        {
                            "source": "a",
                            "target": "b",
                            "relation": "r",
                            "confidence": "INFERRED",
                            "confidence_score": 0.75,
                        },
                        {
                            "source": "a",
                            "target": "ghost",
                            "relation": "r",
                            "confidence": "INFERRED",
                            "confidence_score": 0.75,
                        },
                    ],
                }
            )
        )
        stats = ExtractionStats()
        out = propose_semantic_edges(self._nodes(), [], client, stats=stats)
        assert len(out) == 1
        assert stats.invalid_edges == 1

    def test_skips_duplicates_of_existing_edges(self):
        client = StubClient(
            json.dumps(
                {
                    "edges": [
                        {
                            "source": "a",
                            "target": "b",
                            "relation": "r",
                            "confidence": "INFERRED",
                            "confidence_score": 0.75,
                        },
                    ],
                }
            )
        )
        out = propose_semantic_edges(self._nodes(), [("a", "b")], client)
        assert out == []

    def test_empty_input_skips_llm_call(self):
        client = StubClient(json.dumps({"edges": []}))
        out = propose_semantic_edges([], [], client)
        assert out == []
        assert client.calls == []


# ---------------------------------------------------------------------------
# propose_hyperedges
# ---------------------------------------------------------------------------


class TestProposeHyperedges:
    def _nodes(self):
        return [
            PredictedEntity(id="a", label="A"),
            PredictedEntity(id="b", label="B"),
            PredictedEntity(id="c", label="C"),
            PredictedEntity(id="d", label="D"),
        ]

    def test_filters_invalid_members(self):
        client = StubClient(
            json.dumps(
                {
                    "hyperedges": [
                        {
                            "name": "Flow",
                            "relation": "participate_in",
                            "members": ["a", "b", "ghost", "c"],
                            "confidence": "INFERRED",
                            "confidence_score": 0.75,
                        }
                    ]
                }
            )
        )
        out = propose_hyperedges(self._nodes(), client)
        assert len(out) == 1
        assert set(out[0].members) == {"a", "b", "c"}

    def test_drops_hyperedge_with_fewer_than_3_valid_members(self):
        client = StubClient(
            json.dumps(
                {
                    "hyperedges": [
                        {
                            "name": "Pair",
                            "relation": "form",
                            "members": ["a", "ghost", "b"],
                            "confidence": "INFERRED",
                            "confidence_score": 0.75,
                        },
                    ]
                }
            )
        )
        stats = ExtractionStats()
        out = propose_hyperedges(self._nodes(), client, stats=stats)
        assert out == []
        assert stats.invalid_hyperedges == 1

    def test_drops_hyperedge_missing_required_field(self):
        client = StubClient(
            json.dumps(
                {
                    "hyperedges": [
                        {
                            "name": "No relation",
                            "members": ["a", "b", "c"],
                            "confidence": "INFERRED",
                            "confidence_score": 0.75,
                        },
                    ]
                }
            )
        )
        stats = ExtractionStats()
        out = propose_hyperedges(self._nodes(), client, stats=stats)
        assert out == []
        assert stats.invalid_hyperedges == 1


# ---------------------------------------------------------------------------
# Eval-harness integration
# ---------------------------------------------------------------------------


class TestExtractorAsEvalSubject:
    """Wire the real extractor into the eval harness with a stub LLM."""

    def test_extractor_runs_through_harness(self, tmp_path):
        # Hand-labelled example: the document mentions Login and Token.
        (tmp_path / "ex.md").write_text("# Doc\nLogin issues Token.\n")
        (tmp_path / "ex.json").write_text(
            json.dumps(
                {
                    "id": "ex",
                    "source_type": "prose",
                    "entities": [
                        {"id": "ex_login", "label": "Login"},
                        {"id": "ex_token", "label": "Token"},
                    ],
                    "edges": [
                        {"source": "ex_login", "target": "ex_token", "relation": "issues", "confidence": "EXTRACTED"},
                    ],
                }
            )
        )

        # Stub LLM returns the ground truth verbatim → eval should pass.
        stub = StubClient(
            json.dumps(
                {
                    "entities": [
                        {"id": "ex_login", "label": "Login"},
                        {"id": "ex_token", "label": "Token"},
                    ],
                    "edges": [
                        {
                            "source": "ex_login",
                            "target": "ex_token",
                            "relation": "issues",
                            "confidence": "EXTRACTED",
                            "confidence_score": 1.0,
                        },
                    ],
                }
            )
        )

        def runner(markdown: str):
            return extract_entities(
                AnnotatedMarkdown(markdown=markdown, source_uri="ex.md", source_type="prose"),
                stub,
            )

        from opentrace_agent.benchmarks.llm_extraction_eval import (
            LLMExtractionEvalBenchmark,
        )

        report = LLMExtractionEvalBenchmark(runner).run(tmp_path)
        assert report.entity_precision == 1.0
        assert report.entity_recall == 1.0
        assert report.edge_precision == 1.0
        passed, failures = report.passes_release_bar()
        assert passed, f"unexpected failures: {failures}"
