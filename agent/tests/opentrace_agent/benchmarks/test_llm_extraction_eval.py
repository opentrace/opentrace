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

"""Tests for the LLM extraction eval harness."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from opentrace_agent.benchmarks.llm_extraction_eval import (
    ExtractionExample,
    GroundTruthEdge,
    GroundTruthEntity,
    LLMExtractionEvalBenchmark,
    Predicted,
    PredictedEdge,
    PredictedEntity,
    null_extractor,
    score_example,
)


def _write_example(corpus: Path, name: str, entities: list[dict], edges: list[dict]) -> None:
    (corpus / f"{name}.md").write_text(f"# {name}\nbody")
    (corpus / f"{name}.json").write_text(
        json.dumps({"id": name, "source_type": "prose", "entities": entities, "edges": edges})
    )


@pytest.fixture()
def corpus(tmp_path):
    d = tmp_path / "corpus"
    d.mkdir()
    return d


class TestExtractionExampleLoad:
    def test_round_trip(self, corpus):
        _write_example(
            corpus,
            "ex1",
            [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
            [{"source": "a", "target": "b", "relation": "calls", "confidence": "EXTRACTED"}],
        )
        ex = ExtractionExample.load(corpus / "ex1.json")
        assert ex.id == "ex1"
        assert ex.source_type == "prose"
        assert len(ex.entities) == 2
        assert ex.entities[0].id == "a"
        assert len(ex.edges) == 1
        assert ex.edges[0].relation == "calls"

    def test_missing_markdown_raises(self, corpus):
        (corpus / "ex1.json").write_text('{"id": "ex1", "entities": [], "edges": []}')
        with pytest.raises(FileNotFoundError):
            ExtractionExample.load(corpus / "ex1.json")


class TestScoring:
    def _make_example(self):
        return ExtractionExample(
            id="t",
            source_type="prose",
            markdown="",
            entities=[
                GroundTruthEntity(id="a", label="A"),
                GroundTruthEntity(id="b", label="B"),
            ],
            edges=[
                GroundTruthEdge(source="a", target="b", relation="calls", confidence="EXTRACTED"),
            ],
        )

    def test_perfect_score(self):
        ex = self._make_example()
        predicted = Predicted(
            entities=[PredictedEntity(id="a", label="A"), PredictedEntity(id="b", label="B")],
            edges=[
                PredictedEdge(
                    source="a",
                    target="b",
                    relation="calls",
                    confidence="EXTRACTED",
                    confidence_score=1.0,
                ),
            ],
        )
        s = score_example(ex, predicted)
        assert s.entity_precision == 1.0
        assert s.entity_recall == 1.0
        assert s.edge_precision == 1.0
        assert s.edge_recall == 1.0
        # Calibration: all EXTRACTED predictions were correct
        predicted_count, correct_count = s.tier_counts["EXTRACTED"]
        assert predicted_count == 1
        assert correct_count == 1

    def test_false_positive_hurts_precision(self):
        ex = self._make_example()
        predicted = Predicted(
            entities=[
                PredictedEntity(id="a", label="A"),
                PredictedEntity(id="b", label="B"),
                PredictedEntity(id="hallucinated", label="X"),
            ],
            edges=[],
        )
        s = score_example(ex, predicted)
        assert s.entity_tp == 2
        assert s.entity_fp == 1
        assert s.entity_fn == 0
        assert abs(s.entity_precision - 2 / 3) < 1e-9
        assert s.entity_recall == 1.0

    def test_missing_entity_hurts_recall(self):
        ex = self._make_example()
        predicted = Predicted(entities=[PredictedEntity(id="a", label="A")], edges=[])
        s = score_example(ex, predicted)
        assert s.entity_tp == 1
        assert s.entity_fn == 1
        assert s.entity_precision == 1.0
        assert s.entity_recall == 0.5

    def test_wrong_relation_counted_as_separate_edge(self):
        ex = self._make_example()
        predicted = Predicted(
            entities=[PredictedEntity(id="a", label="A"), PredictedEntity(id="b", label="B")],
            edges=[
                PredictedEdge(
                    source="a",
                    target="b",
                    relation="depends_on",
                    confidence="INFERRED",
                    confidence_score=0.7,
                ),
            ],
        )
        s = score_example(ex, predicted)
        assert s.edge_tp == 0
        assert s.edge_fp == 1
        assert s.edge_fn == 1


class TestRunner:
    def test_null_extractor_on_empty_corpus(self, corpus):
        report = LLMExtractionEvalBenchmark(null_extractor).run(corpus)
        assert report.total == 0
        assert report.errors == 0
        assert report.entity_precision == 0.0

    def test_null_extractor_floor(self, corpus):
        _write_example(
            corpus,
            "ex1",
            [{"id": "a", "label": "A"}],
            [{"source": "a", "target": "a", "relation": "self", "confidence": "EXTRACTED"}],
        )
        report = LLMExtractionEvalBenchmark(null_extractor).run(corpus)
        assert report.total == 1
        assert report.entity_precision == 0.0
        assert report.entity_recall == 0.0
        passed, failures = report.passes_release_bar()
        assert not passed
        assert any("entity precision" in f for f in failures)

    def test_perfect_extractor_passes_bar(self, corpus):
        _write_example(
            corpus,
            "ex1",
            [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
            [{"source": "a", "target": "b", "relation": "calls", "confidence": "EXTRACTED"}],
        )

        def oracle(markdown: str) -> Predicted:  # noqa: ARG001
            return Predicted(
                entities=[PredictedEntity(id="a", label="A"), PredictedEntity(id="b", label="B")],
                edges=[
                    PredictedEdge(
                        source="a",
                        target="b",
                        relation="calls",
                        confidence="EXTRACTED",
                        confidence_score=1.0,
                    ),
                ],
            )

        report = LLMExtractionEvalBenchmark(oracle).run(corpus)
        assert report.entity_precision == 1.0
        assert report.edge_precision == 1.0
        passed, failures = report.passes_release_bar()
        assert passed, f"unexpected failures: {failures}"

    def test_extractor_exception_recorded_as_error(self, corpus):
        _write_example(
            corpus,
            "ex1",
            [{"id": "a", "label": "A"}],
            [],
        )

        def broken(markdown: str) -> Predicted:  # noqa: ARG001
            raise RuntimeError("boom")

        report = LLMExtractionEvalBenchmark(broken).run(corpus)
        assert report.errors == 1
        assert report.total == 1
        assert report.scores[0].error == "boom"

    def test_calibration_within_tolerance(self, corpus):
        # Three EXTRACTED predictions, all correct → actual=100%, expected=100%, err=0.
        # Three INFERRED predictions, 2 correct → actual=66.7%, expected=70%, err=~0.03.
        # Two AMBIGUOUS predictions, 0 correct → actual=0%, expected=25%, err=0.25 (over tolerance).
        gold_entities = [{"id": f"e{i}", "label": str(i)} for i in range(8)]
        gold_edges = [
            *[
                {"source": f"e{i}", "target": f"e{i + 1}", "relation": "rel", "confidence": "EXTRACTED"}
                for i in range(3)
            ],
            *[
                {"source": f"e{i}", "target": f"e{i + 1}", "relation": "rel", "confidence": "INFERRED"}
                for i in range(3, 5)
            ],
        ]
        _write_example(corpus, "ex1", gold_entities, gold_edges)

        def predictor(markdown: str) -> Predicted:  # noqa: ARG001
            return Predicted(
                entities=[PredictedEntity(id=f"e{i}", label=str(i)) for i in range(8)],
                edges=[
                    # 3 EXTRACTED, all correct
                    PredictedEdge(
                        source="e0", target="e1", relation="rel", confidence="EXTRACTED", confidence_score=1.0
                    ),
                    PredictedEdge(
                        source="e1", target="e2", relation="rel", confidence="EXTRACTED", confidence_score=1.0
                    ),
                    PredictedEdge(
                        source="e2", target="e3", relation="rel", confidence="EXTRACTED", confidence_score=1.0
                    ),
                    # 3 INFERRED, 2 correct (e3→e4 + e4→e5 correct, e5→e6 wrong)
                    PredictedEdge(
                        source="e3", target="e4", relation="rel", confidence="INFERRED", confidence_score=0.7
                    ),
                    PredictedEdge(
                        source="e4", target="e5", relation="rel", confidence="INFERRED", confidence_score=0.7
                    ),
                    PredictedEdge(
                        source="e5", target="e6", relation="rel", confidence="INFERRED", confidence_score=0.7
                    ),
                    # 2 AMBIGUOUS, 0 correct
                    PredictedEdge(
                        source="e6", target="e7", relation="hallucinated", confidence="AMBIGUOUS", confidence_score=0.2
                    ),
                    PredictedEdge(
                        source="e7", target="e6", relation="hallucinated", confidence="AMBIGUOUS", confidence_score=0.2
                    ),
                ],
            )

        report = LLMExtractionEvalBenchmark(predictor).run(corpus)
        tier = report.tier_accuracy()
        assert tier["EXTRACTED"]["calibration_error"] == 0.0
        assert tier["INFERRED"]["calibration_error"] < 0.1
        assert tier["AMBIGUOUS"]["calibration_error"] > 0.15
        passed, failures = report.passes_release_bar()
        assert not passed
        assert any("AMBIGUOUS calibration" in f for f in failures)
