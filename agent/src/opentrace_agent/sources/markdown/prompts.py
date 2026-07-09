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

"""Prompts for LLM extraction over markdown, code, and media transcripts.

Four prompts cover the full pipeline:

* :data:`ENTITY_PROMPT` — prose markdown → ``{entities, edges}``. Used for
  doc files (docs, papers, notes).
* :data:`MEDIA_ENTITY_PROMPT` — image / audio / video transcriptions →
  ``{entities, edges}``. Used when markitdown has converted a media file
  to a textual description or transcript. Per-modality guidance discourages
  the model from extracting low-level transcription artifacts.
* :data:`SEMANTIC_EDGE_PROMPT` — neighbourhood of existing nodes →
  proposed semantic edges. Run as a second pass over the assembled graph
  to surface relationships the entity prompt couldn't see locally.
* :data:`HYPEREDGE_PROMPT` — neighbourhood → proposed hyperedges (3+ nodes
  participating in a shared idea/flow).

Constraints (rules, not text):

* Discrete confidence scores. ``EXTRACTED=1.0``, ``INFERRED ∈ {0.55, 0.65,
  0.75, 0.85, 0.95}``, ``AMBIGUOUS ∈ [0.1, 0.3]``. Never 0.5.
* Deterministic node IDs from ``{stem}_{entity}`` lowercased to
  ``[a-z0-9_]``. The :func:`make_entity_id` helper enforces it.
* AMBIGUOUS edges are preserved, not omitted.
* Validation rejects rather than repairs (handled in ``extractor.py``).

The prompts are intentionally terse — every extra sentence is overhead on
the token budget and a chance for the model to drift. Iterate against
``opentraceai-bench llm-extraction-eval``, not in the abstract.
"""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Helpers used by both the prompts and the extractor (for validation).
# ---------------------------------------------------------------------------


_ID_SAFE = re.compile(r"[^a-z0-9_]+")


def make_entity_id(stem: str, entity_name: str) -> str:
    """Produce a deterministic entity ID from a source stem + entity name.

    ``stem`` is typically the source filename without extension; ``entity_name``
    is the human-readable label. Both are lowercased, stripped of
    non-alphanumerics, and joined with an underscore. Stable across runs so
    repeated extractions converge instead of accumulating duplicates.
    """
    s = _ID_SAFE.sub("_", stem.lower()).strip("_") or "doc"
    e = _ID_SAFE.sub("_", entity_name.lower()).strip("_") or "entity"
    return f"{s}_{e}"


VALID_CONFIDENCE_TIERS: frozenset[str] = frozenset({"EXTRACTED", "INFERRED", "AMBIGUOUS"})


# Allowed confidence scores keyed by tier. Discrete rubric so calibration
# metrics actually mean something — soft 0.5 defaults are the failure mode
# this rubric is designed to prevent.
ALLOWED_CONFIDENCE_SCORES: dict[str, frozenset[float]] = {
    "EXTRACTED": frozenset({1.0}),
    "INFERRED": frozenset({0.55, 0.65, 0.75, 0.85, 0.95}),
    "AMBIGUOUS": frozenset({0.1, 0.15, 0.2, 0.25, 0.3}),
}


def round_confidence(tier: str, score: float) -> float:
    """Snap an LLM-reported score to the nearest allowed value for its tier.

    Models sometimes drift toward 0.5 or report continuous values; snapping
    preserves the calibration property and keeps the eval harness honest.
    """
    allowed = ALLOWED_CONFIDENCE_SCORES.get(tier)
    if not allowed:
        return 0.0
    return min(allowed, key=lambda v: abs(v - score))


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------


ENTITY_PROMPT = """\
Identify what the document below is about — its subjects — and how those \
subjects relate to each other. The result becomes part of OpenTrace's \
knowledge graph.

Respond with the single JSON object described under OUTPUT SHAPE and \
nothing else: nothing before it, nothing after it, no code fences.

WHAT TO EXTRACT

A reader's-eye view: things the document is *about*, not every named token \
it contains. If you wouldn't put it on an index card summarising this doc, \
skip it.

Types (pick the closest fit; be consistent across documents):
- idea:    a concept, technique, algorithm, pattern, or methodology
- service: a runnable system, product, command, external tool, or API
- module:  a software component, library, or codebase subdivision
- paper:   an external publication or citation — NOT another file in this corpus
- person:  a real named human — NOT a role or job title
- event:   a specific occurrence at a point in time (release, incident, talk)

DO NOT EXTRACT

- Configuration: CLI flags (`--foo`), environment variables (`OT_*`), config
  keys. These are properties of their parent command or module.
- Schema vocabulary: graph node-type labels ("Class Node", "Page Node"),
  edge-type labels ("MENTIONS edge", "DERIVED_FROM edge"), or any term whose
  role in the text is to describe the extraction system itself.
- The type names above used as their own example ("Idea Entity",
  "Service Entity", "Module Entity", etc.) — those are meta-references,
  not instances.
- File paths, function signatures, import statements, individual functions
  imported from a library. The library is one entity; its functions are not.
- Boilerplate: license headers, copyright notices, ticket / issue IDs
  embedded in comments, version strings.
- Cross-references to other documents in this same corpus. A doc linking to
  a sibling doc is structural navigation, not a citation.

When in doubt, skip. The test is qualitative: every entity should be \
something a reader would describe as a *subject of* this document, not \
something it merely *mentions*. There is no upper limit — an \
encyclopedic document may legitimately name many subjects. But if your \
extraction count tracks file length rather than concept density, you are \
extracting mentions, not entities.

EXAMPLES

In a CLI reference listing 9 commands and 40 flags: extract the 9 commands \
plus a handful of cross-cutting concepts ("autoprune", "knowledge graph"). \
Do not extract the 40 flags.

In an architecture overview that names 12 graph node types: extract the \
overarching architectural idea ("three-layer graph"). Do not extract the \
12 node-type names individually — those describe the schema, not the system.

GRANULARITY

- One entity per concept, not per mention. Reuse the same ID across mentions.
- One entity per library, not per function.
- A command and its sub-flags share one entity (the command).

CONFIDENCE

Tier each edge by how the source supports it, then score within the tier:

- EXTRACTED, score 1.0 — the text states the relationship outright.
- INFERRED, score 0.55 / 0.65 / 0.75 / 0.85 / 0.95 — follows from the
  text without being stated.
- AMBIGUOUS, score 0.1 / 0.15 / 0.2 / 0.25 / 0.3 — you suspect the
  relationship but the source leaves real doubt. Keep these edges in the
  output; never drop them.
- 0.5 is not a legal score.

IDS

Lowercase `[a-z0-9_]` only. Format `{stem}_{entity}` where `stem` is the \
source-file stem and `entity` is the entity name normalised the same way. \
Reuse the same ID for the same entity.

OUTPUT SHAPE (no other keys)

{
  "entities": [
    {"id": "<stem>_<entity>", "label": "<human readable>",
     "type": "idea|service|module|paper|person|event"}
  ],
  "edges": [
    {"source": "<id>", "target": "<id>", "relation": "<verb>",
     "confidence": "EXTRACTED|INFERRED|AMBIGUOUS", "confidence_score": <float>}
  ]
}

Stem for this document: {STEM}

Markdown:
---
{MARKDOWN}
---
"""


MEDIA_ENTITY_PROMPT = """\
The text below is a machine transcription or description of a media file \
(image, audio, or video). Work out what the media is *about* — its \
subjects and how they relate — for OpenTrace's knowledge graph. The \
transcription is evidence about the media, not the subject itself: \
extract through it, not from it.

Respond with the single JSON object described under OUTPUT SHAPE and \
nothing else: nothing before it, nothing after it, no code fences.

WHAT TO EXTRACT

Per modality:

- Diagrams and whiteboard sketches: the systems or concepts drawn, plus
  the relationships the arrows and groupings assert. Where the description
  says a label was hard to read, any edge built on that label belongs in
  the AMBIGUOUS tier — neither silently dropped nor confidently asserted.
- Charts, plots, and research figures: the quantity shown, the system or
  method it concerns, and the trend or claim the figure makes.
- Screenshots of software: the application and what the screen is for —
  not the widgets on it.
- Photographs: subjects identified by name (a person, a place, an
  occasion) — never positional descriptions like "person on left".
- Audio / video: named speakers, the topics discussed, and any systems,
  papers, or events that come up. Utterance-level detail is transcription
  residue, not subject matter.

Types (pick the closest fit; be consistent):
- idea:    a concept, technique, algorithm, claim, or methodology
- service: a runnable system, product, command, external tool, or API
- module:  a software component or codebase subdivision
- paper:   an external publication or citation
- person:  a real named human (speaker, author, subject)
- event:   a specific occurrence at a point in time

DO NOT EXTRACT

- Visual artifacts: pixel coordinates, colour names, font choices,
  "in the upper-right corner" descriptions. Layout patterns are entities;
  layout coordinates are not.
- Filler words, "uh", "you know", transcription artifacts, generic
  speaker labels like "Speaker 1" when no name was given.
- Timestamps, file metadata, codec info, watermarks.
- OCR'd UI chrome: button labels, menu items, breadcrumb paths. Unless
  the file is *about* that UI element, skip it.
- Hallucinated content: if the description is vague ("a person speaking"),
  do not invent specifics.

When in doubt, skip. The test is qualitative: every entity should be \
something the media is *about*, not something it merely *depicts* or \
*utters in passing*. There is no upper limit — a long talk or detailed \
diagram may legitimately name many. But if your count tracks transcript \
length or pixel detail rather than what the media is *about*, you are \
extracting transcription detail, not entities.

EXAMPLES

A UI screenshot of a graph-visualisation tool: extract the tool itself \
(one `service`), maybe the rendering technique it uses (one `idea`). Do \
not extract every button, menu item, or panel title.

A research figure showing a metric over time: extract the metric (one \
`idea`) and the system being measured (one `service` or `module`). Do \
not extract axis labels or legend strings.

A podcast transcript: extract named speakers (`person`), topics discussed \
(`idea`), and any products or papers mentioned. Do not extract filler \
words or sentence-level utterances.

CONFIDENCE

Tier each edge by how the source supports it, then score within the tier:

- EXTRACTED, score 1.0 — the media names or shows the relationship outright.
- INFERRED, score 0.55 / 0.65 / 0.75 / 0.85 / 0.95 — follows from what is
  shown without being shown directly.
- AMBIGUOUS, score 0.1 / 0.15 / 0.2 / 0.25 / 0.3 — reach for this tier
  freely with visual content: the description you are reading may itself
  have misread the image. Keep these edges in the output; never drop them.
- 0.5 is not a legal score.

IDS

Lowercase `[a-z0-9_]` only. Format `{stem}_{entity}` where `stem` is the \
source-file stem and `entity` is the entity name normalised the same way. \
Reuse the same ID for the same entity.

OUTPUT SHAPE (no other keys)

{
  "entities": [
    {"id": "<stem>_<entity>", "label": "<human readable>",
     "type": "idea|service|module|paper|person|event"}
  ],
  "edges": [
    {"source": "<id>", "target": "<id>", "relation": "<verb>",
     "confidence": "EXTRACTED|INFERRED|AMBIGUOUS", "confidence_score": <float>}
  ]
}

Stem for this source: {STEM}

Transcribed content:
---
{MARKDOWN}
---
"""


SEMANTIC_EDGE_PROMPT = """\
You are an OpenTrace semantic-edge agent. The graph below contains nodes you \
must NOT invent more of. Propose edges between existing nodes that surface \
non-structural relationships: semantic similarity, citation, rationale_for, \
implies, contradicts.

Respond with the single JSON object described under "Output shape" and \
nothing else: nothing before it, nothing after it, no code fences.

Constraints:
- source/target MUST be one of the node IDs in the input. Hallucinated IDs are rejected.
- Score within the edge's tier: EXTRACTED is always 1.0; INFERRED picks from
  0.55 / 0.65 / 0.75 / 0.85 / 0.95; AMBIGUOUS picks from 0.1 / 0.15 / 0.2 /
  0.25 / 0.3. 0.5 is not a legal score.
- Skip pairs that are already connected by a structural edge in the input.

Output shape:
{
  "edges": [
    {"source": "<existing id>", "target": "<existing id>", "relation": "<verb>",
     "confidence": "EXTRACTED|INFERRED|AMBIGUOUS", "confidence_score": <float>}
  ]
}

Existing nodes:
{NODES}

Existing structural edges (do not duplicate):
{EDGES}
"""


HYPEREDGE_PROMPT = """\
You are an OpenTrace hyperedge agent. The graph below contains nodes you \
must NOT invent more of. Propose hyperedges. A hyperedge names a set of \
at least three existing nodes that act as one unit — a workflow, a \
layered design, a recurring theme — where any pairwise edge between two \
members would understate the group relationship.

Respond with the single JSON object described under "Output shape" and \
nothing else: nothing before it, nothing after it, no code fences.

Constraints:
- Each hyperedge cites at least 3 existing node IDs. Hallucinated IDs are rejected.
- Score within the hyperedge's tier: EXTRACTED is always 1.0; INFERRED picks
  from 0.55 / 0.65 / 0.75 / 0.85 / 0.95; AMBIGUOUS picks from 0.1 / 0.15 /
  0.2 / 0.25 / 0.3. 0.5 is not a legal score.
- ``relation`` is one of: participate_in, implement, form, instantiate.

Output shape:
{
  "hyperedges": [
    {"name": "<short label, 2-5 words>", "relation": "participate_in|implement|form|instantiate",
     "members": ["<existing id>", "<existing id>", ...],
     "confidence": "EXTRACTED|INFERRED|AMBIGUOUS", "confidence_score": <float>}
  ]
}

Existing nodes:
{NODES}
"""
