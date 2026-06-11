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

"""LLM-driven entity + edge extraction from markdown.

Sits between the markdown loader and the graph store. Given an
``AnnotatedMarkdown`` and an LLM client, produces a :class:`Predicted` —
the same shape the eval harness scores — so a prompt iteration can be run
through ``opentraceai-bench llm-extraction-eval`` without any conversion.

The :class:`LLMClient` protocol is intentionally tiny: ``complete(system,
user) -> str``. Any client (Anthropic SDK, OpenAI SDK, local model via
HTTP) can implement it. We don't depend on a specific SDK to keep the
extractor easy to test with deterministic stubs.

Validation rejects rather than repairs:

* JSON that doesn't parse → empty result, logged.
* Hollow response (200 OK but empty/whitespace content) → treated as a
  validation failure and surfaced for adaptive retry.
* Entity IDs the model invented for "existing" graphs → dropped from
  proposed edges/hyperedges.
* Confidence scores outside the discrete rubric → snapped to the closest
  legal value (see :func:`round_confidence`).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Literal, Protocol

from opentrace_agent.benchmarks.llm_extraction_eval import (
    Predicted,
    PredictedEdge,
    PredictedEntity,
)
from opentrace_agent.sources.markdown.loader import AnnotatedMarkdown
from opentrace_agent.sources.markdown.prompts import (
    ALLOWED_CONFIDENCE_SCORES,
    ENTITY_PROMPT,
    HYPEREDGE_PROMPT,
    MEDIA_ENTITY_PROMPT,
    SEMANTIC_EDGE_PROMPT,
    VALID_CONFIDENCE_TIERS,
    make_entity_id,
    round_confidence,
)

# Selection between the prose and media variants of the entity prompt.
# Callers can pass ``kind=`` explicitly; otherwise the extractor picks based
# on ``annotated.source_type`` so media files coming through the docs path
# get the media prompt instead of the prose one.
EntityKind = Literal["prose", "media"]
_ENTITY_PROMPTS: dict[str, str] = {
    "prose": ENTITY_PROMPT,
    "media": MEDIA_ENTITY_PROMPT,
}

# Source-type tokens that should auto-route to the media prompt. Matches the
# values emitted by ``loader.detect_source_type``.
_MEDIA_SOURCE_TYPES: frozenset[str] = frozenset({"image", "audio", "video", "youtube"})

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Client protocol
# ---------------------------------------------------------------------------


# Node-type allowlist for entities emitted by the extractor. ``Idea`` is the
# catch-all (anything the LLM names that doesn't fit a more specific
# Service/Module/Paper/Person/Event type lands here).
VALID_LLM_ENTITY_TYPES: frozenset[str] = frozenset({"Idea", "Service", "Module", "Paper", "Person", "Event"})


def entity_node_type(raw: str) -> str:
    """Normalise the LLM-supplied entity type into a valid store node type.

    The prompt asks for lowercase ("idea", "service", ...). Title-case for
    store consistency. Falls back to ``Idea`` on anything unrecognised —
    that's the catch-all bucket.
    """
    candidate = (raw or "idea").strip().title()
    if candidate in VALID_LLM_ENTITY_TYPES:
        return candidate
    return "Idea"


class LLMClient(Protocol):
    """Minimal surface the extractor needs from any LLM provider.

    Implementations: Anthropic SDK, OpenAI SDK, local model HTTP, or a
    deterministic stub for tests. Should return the model's text response
    verbatim — JSON parsing happens inside the extractor.
    """

    def complete(self, system: str, user: str) -> str: ...


@dataclass
class ExtractionStats:
    """Telemetry produced by an extraction run."""

    chunks_called: int = 0
    json_parse_failures: int = 0
    hollow_responses: int = 0
    invalid_entities: int = 0
    invalid_edges: int = 0
    invalid_hyperedges: int = 0


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _safe_json(raw: str) -> dict | None:
    """Strip optional markdown fences and parse JSON. ``None`` on failure."""
    s = raw.strip()
    if not s:
        return None
    if s.startswith("```"):
        # Strip leading fence (with optional language tag).
        parts = s.split("```", 2)
        if len(parts) >= 2:
            s = parts[1]
            if s.startswith("json"):
                s = s[4:]
            # Trim trailing fence if present.
            s = s.rsplit("```", 1)[0]
    try:
        return json.loads(s)
    except json.JSONDecodeError as exc:
        logger.info("LLM JSON parse failure: %s", exc)
        return None


def _is_hollow(parsed: dict | None) -> bool:
    """True when the model returned a successful response with no usable data.

    A 200 OK that yields no entities/edges/hyperedges is operationally
    indistinguishable from a truncation, and callers want to either retry
    or surface the failure rather than silently drop the chunk.
    """
    if parsed is None:
        return True
    if not any(parsed.get(k) for k in ("entities", "edges", "hyperedges")):
        return True
    return False


def _coerce_score(tier: str, raw_score: object) -> float:
    """Snap a model-reported score to the discrete rubric for its tier."""
    try:
        score = float(raw_score)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        # Default to the bottom of the band so a missing/garbage score doesn't
        # silently inherit higher confidence than the tier merits.
        return min(ALLOWED_CONFIDENCE_SCORES.get(tier, frozenset({0.0})))
    return round_confidence(tier, score)


def _norm_tier(raw: object) -> str | None:
    if isinstance(raw, str):
        t = raw.upper().strip()
        if t in VALID_CONFIDENCE_TIERS:
            return t
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _resolve_kind(annotated: AnnotatedMarkdown, override: EntityKind | None) -> EntityKind:
    """Pick a prompt variant: explicit override > source_type heuristic > prose."""
    if override is not None:
        return override
    st = (annotated.source_type or "").lower()
    if st in _MEDIA_SOURCE_TYPES:
        return "media"
    return "prose"


def extract_entities(
    annotated: AnnotatedMarkdown,
    client: LLMClient,
    *,
    stats: ExtractionStats | None = None,
    kind: EntityKind | None = None,
) -> Predicted:
    """Run prompt 1 against ``annotated.markdown``. Returns nodes + initial edges.

    ``kind`` selects between the prose- and media-tuned prompt variants.
    When ``None`` (the default), the kind is inferred from
    ``annotated.source_type``: image/audio/video/youtube → media; everything
    else → prose.

    Each entity ID is rewritten with the deterministic ``{stem}_{entity}``
    formula so re-running on the same document converges instead of
    accumulating duplicates.
    """
    stats = stats or ExtractionStats()
    stats.chunks_called += 1
    stem = _stem_from_uri(annotated.source_uri)
    resolved_kind = _resolve_kind(annotated, kind)
    template = _ENTITY_PROMPTS.get(resolved_kind, ENTITY_PROMPT)
    prompt = template.replace("{STEM}", stem).replace("{MARKDOWN}", annotated.markdown)
    raw = client.complete(_SYSTEM_TERSE, prompt)
    parsed = _safe_json(raw)

    if _is_hollow(parsed):
        stats.hollow_responses += 1
        return Predicted()

    return parse_entities(parsed, stem, stats=stats)


def parse_entities(parsed: dict, stem: str, *, stats: ExtractionStats | None = None) -> Predicted:
    """Validate a parsed ``{entities, edges}`` payload into a :class:`Predicted`.

    Shared by the standalone extractor (which JSON-parses a raw completion) and
    the unified wiki doc pass (which receives the dict straight from a
    ``call_tool`` response). Entity IDs are re-derived from labels via the
    deterministic ``{stem}_{entity}`` formula so re-runs converge. Edge
    endpoints are resolved against BOTH the model's original ids and the entity
    labels — the unified-call schema references edges by *label*, the legacy
    prompt by *id* — and any edge whose endpoints don't resolve is dropped.
    """
    stats = stats or ExtractionStats()
    entities_in = parsed.get("entities") or []
    edges_in = parsed.get("edges") or []

    id_remap: dict[str, str] = {}
    label_to_id: dict[str, str] = {}
    out_entities: list[PredictedEntity] = []
    for raw_ent in entities_in:
        if not isinstance(raw_ent, dict):
            stats.invalid_entities += 1
            continue
        label = str(raw_ent.get("label") or raw_ent.get("name") or "").strip()
        type_ = str(raw_ent.get("type") or "concept").strip().lower()
        description = str(raw_ent.get("description") or "").strip()
        if not label:
            stats.invalid_entities += 1
            continue
        canonical_id = make_entity_id(stem, label)
        if (original_id := raw_ent.get("id")) and isinstance(original_id, str):
            id_remap[original_id] = canonical_id
        id_remap[canonical_id] = canonical_id
        label_to_id[label] = canonical_id
        out_entities.append(PredictedEntity(id=canonical_id, label=label, type=type_, description=description))

    def _resolve(ref: object) -> str | None:
        key = str(ref or "")
        return id_remap.get(key) or label_to_id.get(key)

    # Edges — drop anything whose source/target we can't resolve to a real entity.
    out_edges: list[PredictedEdge] = []
    for raw_edge in edges_in:
        if not isinstance(raw_edge, dict):
            stats.invalid_edges += 1
            continue
        source = _resolve(raw_edge.get("source"))
        target = _resolve(raw_edge.get("target"))
        relation = str(raw_edge.get("relation") or "").strip()
        tier = _norm_tier(raw_edge.get("confidence"))
        if not (source and target and relation and tier):
            stats.invalid_edges += 1
            continue
        out_edges.append(
            PredictedEdge(
                source=source,
                target=target,
                relation=relation,
                confidence=tier,  # type: ignore[arg-type]
                confidence_score=_coerce_score(tier, raw_edge.get("confidence_score", 0.0)),
            )
        )

    return Predicted(entities=out_entities, edges=out_edges)


def propose_semantic_edges(
    existing_nodes: list[PredictedEntity],
    existing_edges: list[tuple[str, str]],
    client: LLMClient,
    *,
    stats: ExtractionStats | None = None,
) -> list[PredictedEdge]:
    """Run prompt 2 over an existing neighbourhood. Returns proposed edges only.

    Edges whose endpoints aren't in ``existing_nodes`` are dropped (hallucination
    rejection). Edges that duplicate ``existing_edges`` are also dropped — the
    prompt asks the model to skip them, but we enforce it.
    """
    stats = stats or ExtractionStats()
    stats.chunks_called += 1
    if not existing_nodes:
        return []

    valid_ids = {n.id for n in existing_nodes}
    existing_pairs = {(s, t) for s, t in existing_edges}

    nodes_blob = "\n".join(f"- {n.id}: {n.label} ({n.type})" for n in existing_nodes)
    edges_blob = "\n".join(f"- {s} -> {t}" for s, t in existing_edges) if existing_edges else "(none)"
    prompt = SEMANTIC_EDGE_PROMPT.replace("{NODES}", nodes_blob).replace("{EDGES}", edges_blob)
    raw = client.complete(_SYSTEM_TERSE, prompt)
    parsed = _safe_json(raw)
    if _is_hollow(parsed):
        stats.hollow_responses += 1
        return []

    out: list[PredictedEdge] = []
    for raw_edge in parsed.get("edges") or []:
        if not isinstance(raw_edge, dict):
            stats.invalid_edges += 1
            continue
        source = raw_edge.get("source")
        target = raw_edge.get("target")
        relation = str(raw_edge.get("relation") or "").strip()
        tier = _norm_tier(raw_edge.get("confidence"))
        if not isinstance(source, str) or not isinstance(target, str):
            stats.invalid_edges += 1
            continue
        if source not in valid_ids or target not in valid_ids:
            stats.invalid_edges += 1
            continue
        if (source, target) in existing_pairs:
            continue  # duplicate, silently skip
        if not relation or not tier:
            stats.invalid_edges += 1
            continue
        out.append(
            PredictedEdge(
                source=source,
                target=target,
                relation=relation,
                confidence=tier,  # type: ignore[arg-type]
                confidence_score=_coerce_score(tier, raw_edge.get("confidence_score", 0.0)),
            )
        )
    return out


@dataclass
class ProposedHyperedge:
    """Output of :func:`propose_hyperedges` — one labelled n-ary grouping."""

    name: str
    relation: str
    members: tuple[str, ...]
    confidence: str  # ConfidenceTier
    confidence_score: float


def propose_hyperedges(
    existing_nodes: list[PredictedEntity],
    client: LLMClient,
    *,
    stats: ExtractionStats | None = None,
) -> list[ProposedHyperedge]:
    """Run prompt 3. Returns hyperedges over existing nodes only.

    Members that aren't in ``existing_nodes`` are dropped from the hyperedge.
    Hyperedges with fewer than 3 valid members after filtering are dropped
    entirely (a 2-member "hyperedge" is just a regular edge).
    """
    stats = stats or ExtractionStats()
    stats.chunks_called += 1
    if not existing_nodes:
        return []

    valid_ids = {n.id for n in existing_nodes}
    nodes_blob = "\n".join(f"- {n.id}: {n.label} ({n.type})" for n in existing_nodes)
    prompt = HYPEREDGE_PROMPT.replace("{NODES}", nodes_blob)
    raw = client.complete(_SYSTEM_TERSE, prompt)
    parsed = _safe_json(raw)
    if _is_hollow(parsed):
        stats.hollow_responses += 1
        return []

    out: list[ProposedHyperedge] = []
    for raw_he in parsed.get("hyperedges") or []:
        if not isinstance(raw_he, dict):
            stats.invalid_hyperedges += 1
            continue
        name = str(raw_he.get("name") or "").strip()
        relation = str(raw_he.get("relation") or "").strip()
        tier = _norm_tier(raw_he.get("confidence"))
        raw_members = raw_he.get("members") or []
        if not name or not relation or not tier or not isinstance(raw_members, list):
            stats.invalid_hyperedges += 1
            continue
        members = tuple(m for m in raw_members if isinstance(m, str) and m in valid_ids)
        if len(members) < 3:
            stats.invalid_hyperedges += 1
            continue
        out.append(
            ProposedHyperedge(
                name=name,
                relation=relation,
                members=members,
                confidence=tier,
                confidence_score=_coerce_score(tier, raw_he.get("confidence_score", 0.0)),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


_SYSTEM_TERSE = (
    "You are an OpenTrace knowledge-graph extractor. Every reply is exactly "
    "one JSON object in the requested schema — no commentary, no fences. "
    "When nothing qualifies, return the schema with empty arrays. Uncertain "
    "findings stay in the output at AMBIGUOUS-tier scores: an edge that is "
    "never emitted can never be reviewed."
)


def _stem_from_uri(uri: str) -> str:
    """Derive a stable filename-style stem from a URI or path."""
    # Strip query string + fragment, then take the last path segment.
    cleaned = uri.split("?")[0].split("#")[0]
    last = cleaned.rsplit("/", 1)[-1] or cleaned
    # Drop the extension.
    if "." in last:
        last = last.rsplit(".", 1)[0]
    return last or "doc"
