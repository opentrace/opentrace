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

"""LLM extraction eval harness.

Measures the quality of an entity/edge extractor (markdown → graph) against
a hand-labelled corpus. The harness is **extractor-agnostic**: callers pass
in any function with signature ``(markdown: str) -> Predicted``.

Three metrics are reported:

* **Entity precision/recall** — by stable node ID match between predicted and
  ground-truth nodes. The extractor is responsible for producing
  deterministic IDs.
* **Edge precision/recall** — by ``(source_id, target_id, relation)`` tuple
  match between predicted and ground-truth edges.
* **Confidence calibration** — for each predicted-edge confidence tier
  (EXTRACTED / INFERRED / AMBIGUOUS), what fraction of edges in that tier
  are actually correct? The release bar requires per-tier calibration within
  0.15 of empirical accuracy.

Corpus format
-------------
A corpus directory contains JSON files plus their accompanying markdown::

    corpus/
      example_001.md        # input the extractor sees
      example_001.json      # ground truth
      ...

Each ``.json`` file has the shape::

    {
      "id": "example_001",
      "source_type": "pdf|word|epub|powerpoint|html|excel|image|audio|video",
      "entities": [
        {"id": "node_a", "label": "Login Service", "type": "concept"},
        ...
      ],
      "edges": [
        {"source": "node_a", "target": "node_b", "relation": "calls",
         "confidence": "EXTRACTED"},
        ...
      ]
    }

A null/stub extractor reports 0% precision deterministically — useful as a
floor and for testing the harness itself.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Protocol

logger = logging.getLogger(__name__)

ConfidenceTier = Literal["EXTRACTED", "INFERRED", "AMBIGUOUS"]
CONFIDENCE_TIERS: tuple[ConfidenceTier, ...] = ("EXTRACTED", "INFERRED", "AMBIGUOUS")

# Release bar — see module docstring + the implementation plan.
ENTITY_PRECISION_BAR = 0.90
EDGE_PRECISION_BAR = 0.80
CALIBRATION_TOLERANCE = 0.15


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GroundTruthEntity:
    id: str
    label: str
    type: str = "concept"


@dataclass(frozen=True)
class GroundTruthEdge:
    source: str
    target: str
    relation: str
    confidence: ConfidenceTier = "EXTRACTED"


@dataclass(frozen=True)
class PredictedEntity:
    id: str
    label: str
    type: str = "concept"
    description: str = ""


@dataclass(frozen=True)
class PredictedEdge:
    source: str
    target: str
    relation: str
    confidence: ConfidenceTier
    confidence_score: float = 0.0


@dataclass
class ExtractionExample:
    """One hand-labelled corpus entry: source markdown + ground truth."""

    id: str
    source_type: str
    markdown: str
    entities: list[GroundTruthEntity]
    edges: list[GroundTruthEdge]

    @classmethod
    def load(cls, json_path: Path) -> "ExtractionExample":
        data = json.loads(json_path.read_text())
        md_path = json_path.with_suffix(".md")
        if not md_path.exists():
            raise FileNotFoundError(f"Missing markdown for {json_path.name}: expected {md_path}")
        return cls(
            id=data["id"],
            source_type=data.get("source_type", "unknown"),
            markdown=md_path.read_text(),
            entities=[GroundTruthEntity(**e) for e in data.get("entities", [])],
            edges=[GroundTruthEdge(**e) for e in data.get("edges", [])],
        )


@dataclass
class Predicted:
    """Output of an extractor: nodes + edges in the same shape as ground truth."""

    entities: list[PredictedEntity] = field(default_factory=list)
    edges: list[PredictedEdge] = field(default_factory=list)


class Extractor(Protocol):
    """An LLM extractor: markdown → graph fragment."""

    def __call__(self, markdown: str) -> Predicted: ...


def null_extractor(markdown: str) -> Predicted:  # noqa: ARG001
    """Baseline: returns nothing. Useful as a floor and for harness self-tests."""
    return Predicted()


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------


@dataclass
class ExtractionScore:
    """Per-example score."""

    example_id: str
    source_type: str
    duration_ms: float

    entity_tp: int = 0
    entity_fp: int = 0
    entity_fn: int = 0

    edge_tp: int = 0
    edge_fp: int = 0
    edge_fn: int = 0

    # Per-tier (tier → [predicted_count, correct_count])
    tier_counts: dict[ConfidenceTier, tuple[int, int]] = field(default_factory=dict)

    error: str | None = None

    @property
    def entity_precision(self) -> float:
        return _safe_div(self.entity_tp, self.entity_tp + self.entity_fp)

    @property
    def entity_recall(self) -> float:
        return _safe_div(self.entity_tp, self.entity_tp + self.entity_fn)

    @property
    def edge_precision(self) -> float:
        return _safe_div(self.edge_tp, self.edge_tp + self.edge_fp)

    @property
    def edge_recall(self) -> float:
        return _safe_div(self.edge_tp, self.edge_tp + self.edge_fn)


def _safe_div(num: int, den: int) -> float:
    return num / den if den > 0 else 0.0


def score_example(example: ExtractionExample, predicted: Predicted) -> ExtractionScore:
    """Score a single example by comparing predicted vs. ground truth.

    Entities are matched by stable ID. Edges are matched by the
    ``(source, target, relation)`` triple, also using IDs as the source/target
    coordinates so name normalisation can't shift the comparison.
    """
    gold_entity_ids = {e.id for e in example.entities}
    pred_entity_ids = {e.id for e in predicted.entities}

    entity_tp = len(gold_entity_ids & pred_entity_ids)
    entity_fp = len(pred_entity_ids - gold_entity_ids)
    entity_fn = len(gold_entity_ids - pred_entity_ids)

    def edge_key(s: str, t: str, r: str) -> tuple[str, str, str]:
        return (s, t, r)

    gold_edges = {edge_key(e.source, e.target, e.relation) for e in example.edges}
    pred_edges = {edge_key(e.source, e.target, e.relation) for e in predicted.edges}

    edge_tp = len(gold_edges & pred_edges)
    edge_fp = len(pred_edges - gold_edges)
    edge_fn = len(gold_edges - pred_edges)

    # Per-tier calibration: for each tier, how many predicted edges were correct?
    tier_counts: dict[ConfidenceTier, tuple[int, int]] = {t: (0, 0) for t in CONFIDENCE_TIERS}
    for e in predicted.edges:
        key = edge_key(e.source, e.target, e.relation)
        predicted_count, correct_count = tier_counts.get(e.confidence, (0, 0))
        predicted_count += 1
        if key in gold_edges:
            correct_count += 1
        tier_counts[e.confidence] = (predicted_count, correct_count)

    return ExtractionScore(
        example_id=example.id,
        source_type=example.source_type,
        duration_ms=0.0,
        entity_tp=entity_tp,
        entity_fp=entity_fp,
        entity_fn=entity_fn,
        edge_tp=edge_tp,
        edge_fp=edge_fp,
        edge_fn=edge_fn,
        tier_counts=tier_counts,
    )


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


# Expected calibration: predictions tagged EXTRACTED should be ~100% correct,
# INFERRED ~70%, AMBIGUOUS ~25%. Calibration error = |actual - expected|.
EXPECTED_TIER_ACCURACY: dict[ConfidenceTier, float] = {
    "EXTRACTED": 1.0,
    "INFERRED": 0.7,
    "AMBIGUOUS": 0.25,
}


@dataclass
class ExtractionEvalReport:
    """Aggregate eval report. Mirrors ``BenchmarkReport`` for CLI parity."""

    suite_name: str
    total: int
    errors: int
    duration_ms: float
    scores: list[ExtractionScore]

    @property
    def entity_precision(self) -> float:
        tp = sum(s.entity_tp for s in self.scores)
        fp = sum(s.entity_fp for s in self.scores)
        return _safe_div(tp, tp + fp)

    @property
    def entity_recall(self) -> float:
        tp = sum(s.entity_tp for s in self.scores)
        fn = sum(s.entity_fn for s in self.scores)
        return _safe_div(tp, tp + fn)

    @property
    def edge_precision(self) -> float:
        tp = sum(s.edge_tp for s in self.scores)
        fp = sum(s.edge_fp for s in self.scores)
        return _safe_div(tp, tp + fp)

    @property
    def edge_recall(self) -> float:
        tp = sum(s.edge_tp for s in self.scores)
        fn = sum(s.edge_fn for s in self.scores)
        return _safe_div(tp, tp + fn)

    def tier_accuracy(self) -> dict[ConfidenceTier, dict[str, float | int]]:
        """Empirical accuracy + calibration error per confidence tier."""
        out: dict[ConfidenceTier, dict[str, float | int]] = {}
        for tier in CONFIDENCE_TIERS:
            predicted = sum(s.tier_counts.get(tier, (0, 0))[0] for s in self.scores)
            correct = sum(s.tier_counts.get(tier, (0, 0))[1] for s in self.scores)
            actual = _safe_div(correct, predicted)
            expected = EXPECTED_TIER_ACCURACY[tier]
            out[tier] = {
                "predicted": predicted,
                "correct": correct,
                "actual_accuracy": actual,
                "expected_accuracy": expected,
                "calibration_error": abs(actual - expected) if predicted > 0 else 0.0,
            }
        return out

    def passes_release_bar(self) -> tuple[bool, list[str]]:
        """Check the concrete numbers from the implementation plan."""
        failures: list[str] = []
        if self.entity_precision < ENTITY_PRECISION_BAR:
            failures.append(f"entity precision {self.entity_precision:.2%} < bar {ENTITY_PRECISION_BAR:.0%}")
        if self.edge_precision < EDGE_PRECISION_BAR:
            failures.append(f"edge precision {self.edge_precision:.2%} < bar {EDGE_PRECISION_BAR:.0%}")
        for tier, stats in self.tier_accuracy().items():
            if stats["predicted"] == 0:
                continue
            cal = stats["calibration_error"]
            if cal > CALIBRATION_TOLERANCE:
                failures.append(f"{tier} calibration error {cal:.2f} > tolerance {CALIBRATION_TOLERANCE:.2f}")
        return not failures, failures

    def summary(self, *, verbose: bool = False) -> str:
        lines = [
            f"LLM extraction eval: {self.suite_name}",
            f"  Examples: {self.total}  Errors: {self.errors}  Duration: {self.duration_ms:.0f}ms",
            f"  Entity precision: {self.entity_precision:.2%}  recall: {self.entity_recall:.2%}",
            f"  Edge   precision: {self.edge_precision:.2%}  recall: {self.edge_recall:.2%}",
            "  Confidence calibration:",
        ]
        for tier, stats in self.tier_accuracy().items():
            lines.append(
                f"    {tier:<10} predicted={stats['predicted']:>4}  "
                f"actual={stats['actual_accuracy']:.2%}  "
                f"expected={stats['expected_accuracy']:.2%}  "
                f"err={stats['calibration_error']:.2f}"
            )
        passed, failures = self.passes_release_bar()
        lines.append("")
        if passed:
            lines.append("  RELEASE BAR: PASS")
        else:
            lines.append("  RELEASE BAR: FAIL")
            for f in failures:
                lines.append(f"    - {f}")
        if verbose:
            lines.append("")
            lines.append("  Per-example:")
            for s in self.scores:
                marker = " ERROR" if s.error else ""
                lines.append(
                    f"    {s.example_id:<24} ({s.source_type:>10})  "
                    f"E P={s.entity_precision:.0%} R={s.entity_recall:.0%}  "
                    f"E2 P={s.edge_precision:.0%} R={s.edge_recall:.0%}{marker}"
                )
        return "\n".join(lines)

    def to_dict(self) -> dict[str, Any]:
        passed, failures = self.passes_release_bar()
        return {
            "suite_name": self.suite_name,
            "total": self.total,
            "errors": self.errors,
            "duration_ms": self.duration_ms,
            "entity_precision": self.entity_precision,
            "entity_recall": self.entity_recall,
            "edge_precision": self.edge_precision,
            "edge_recall": self.edge_recall,
            "tier_accuracy": self.tier_accuracy(),
            "release_bar_passed": passed,
            "release_bar_failures": failures,
            "scores": [asdict(s) for s in self.scores],
        }


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


class LLMExtractionEvalBenchmark:
    """Run an extractor against a corpus and produce an :class:`ExtractionEvalReport`."""

    def __init__(self, extractor: Extractor | Callable[[str], Predicted] = null_extractor) -> None:
        self._extractor = extractor

    def run(self, corpus_dir: str | Path) -> ExtractionEvalReport:
        corpus = Path(corpus_dir)
        if not corpus.exists():
            raise FileNotFoundError(f"Corpus directory not found: {corpus}")

        json_paths = sorted(corpus.glob("*.json"))
        if not json_paths:
            logger.warning("No examples found in %s", corpus)

        scores: list[ExtractionScore] = []
        errors = 0
        start = time.perf_counter()
        for jp in json_paths:
            try:
                example = ExtractionExample.load(jp)
            except (FileNotFoundError, json.JSONDecodeError) as exc:
                logger.warning("Skipping %s: %s", jp, exc)
                errors += 1
                continue

            t0 = time.perf_counter()
            try:
                predicted = self._extractor(example.markdown)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Extractor failed on %s: %s", example.id, exc)
                scores.append(
                    ExtractionScore(
                        example_id=example.id,
                        source_type=example.source_type,
                        duration_ms=(time.perf_counter() - t0) * 1000.0,
                        error=str(exc),
                    )
                )
                errors += 1
                continue

            score = score_example(example, predicted)
            score.duration_ms = (time.perf_counter() - t0) * 1000.0
            scores.append(score)

        duration_ms = (time.perf_counter() - start) * 1000.0
        return ExtractionEvalReport(
            suite_name=corpus.name,
            total=len(scores),
            errors=errors,
            duration_ms=duration_ms,
            scores=scores,
        )
