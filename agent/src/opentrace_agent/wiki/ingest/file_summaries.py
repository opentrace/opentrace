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

"""SummariseSources stage — one file-summary page per newly-ingested source.

Runs after Normalize, before Plan. Each new source becomes a page titled
after the source filename (e.g. ``Midwest Beef Rfp Response``) that's a
*distilled digest* of that document — the wiki layer that sits between a
reader (usually an LLM browsing the vault) and the raw source. Concept pages
produced by the later Execute stage cite file summaries by ``[[Title]]``
wiki-link, giving inline provenance for any factual claim.

The raw post-markitdown body is retained separately in the corpus
(``Source.corpus_path``) and is what concept synthesis actually reads, so this
page is a digest for browsing + citation — NOT the only on-disk record, and
NOT a verbatim transcript.
"""

from __future__ import annotations

import concurrent.futures
import os
import re
from collections.abc import Iterator

from opentrace_agent.wiki.ingest.entities import build_entities
from opentrace_agent.wiki.ingest.execute import _wiki_concurrency, force_h1
from opentrace_agent.wiki.ingest.types import (
    PAGE_KIND_FILE_SUMMARY,
    CompiledPage,
    ConceptMention,
    NormalizedSource,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.llm import WikiLLM
from opentrace_agent.wiki.slugify import unique_slug
from opentrace_agent.wiki.vault import VaultMetadata

# Output budget we request per summary call. A digest + concept/entity inventory
# is small, so this is modest; the client clamps it to the backend's hard cap
# (BackendConfig.max_output_tokens) regardless.
SUMMARY_MAX_TOKENS = 8000

# Chunking: a doc must fit the model's INPUT context to be read in one
# extraction call. Since the digest output is small, input — not the output
# budget — is the binding constraint, so the threshold is generous and the
# chunker is a rare safety net for enormous docs (not the common path). Override
# with OT_WIKI_MAX_DOC_CHARS (e.g. lower it for a small-context local model, or
# to force-split for testing).
DEFAULT_MAX_DOC_CHARS = 120_000
_HEADING_RE = re.compile(r"^#{1,6} ", re.MULTILINE)

FILE_SUMMARY_SCHEMA = {
    "description": "Emit the markdown body, one-line summary, concept inventory, and entity graph for a document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "markdown_body": {
                "type": "string",
                "description": (
                    "Full markdown content for the page, starting with an H1 equal to the supplied page_title."
                ),
            },
            "one_line_summary": {
                "type": "string",
                "description": "One sentence describing the document (NOT its content) — used in the vault index.",
            },
            "concepts": {
                "type": "array",
                "description": (
                    "The document's MAIN recurring concepts, for cross-document synthesis — the handful "
                    "of key themes a reader would say it is about, NOT an exhaustive enumeration of every "
                    "minor mention or list entry."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "The subject matter, e.g. 'validation', 'security', 'pricing'.",
                        },
                        "subject": {
                            "type": "string",
                            "description": (
                                "The real-world entity the concept is a property OF — the product or "
                                "system being documented (e.g. 'pydantic', 'Acme Software'), NOT this file."
                            ),
                        },
                        "gloss": {
                            "type": "string",
                            "description": "One line: what THIS document specifically says about the topic.",
                        },
                    },
                    "required": ["topic", "subject", "gloss"],
                },
            },
            "entities": {
                "type": "array",
                "description": "Named entities this document is ABOUT (knowledge-graph nodes).",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "Human-readable entity name."},
                        "type": {
                            "type": "string",
                            "description": "One of: idea | service | module | paper | person | event.",
                        },
                        "description": {
                            "type": "string",
                            "description": "One line describing what this entity IS (stored on the node).",
                        },
                    },
                    "required": ["label", "type"],
                },
            },
            "edges": {
                "type": "array",
                "description": "Relationships between the entities above (reference entities by their label).",
                "items": {
                    "type": "object",
                    "properties": {
                        "source": {"type": "string", "description": "Label of the source entity."},
                        "target": {"type": "string", "description": "Label of the target entity."},
                        "relation": {"type": "string", "description": "Verb describing the relationship."},
                        "confidence": {
                            "type": "string",
                            "description": "EXTRACTED | INFERRED | AMBIGUOUS.",
                        },
                        "confidence_score": {"type": "number"},
                    },
                    "required": ["source", "target", "relation", "confidence"],
                },
            },
        },
        "required": ["markdown_body", "one_line_summary"],
    },
}


FILE_SUMMARY_SYSTEM = """You are distilling a single uploaded document into a wiki page.

This page is a DIGEST for a knowledge wiki — a reader (usually an LLM) browses
it to grasp what the document says and covers, then follows citations to the
raw source when full detail is needed. The raw source is retained separately,
so this is a digest, NOT a transcript: capture the key claims, decisions,
definitions, and the figures that carry meaning, and drop boilerplate, repeated
examples, and verbatim padding. Aim for a faithful but markedly shorter
rendering — typically a fraction of the source length.

Hard rules:
- The first line MUST be an H1 equal to the supplied page_title (no leading
  prefix, no bracket annotations — the title verbatim).
- Keep the key facts, named entities, and meaningful figures (decisive dates,
  dollar amounts, specifications, IDs) — but you need NOT preserve every number
  or restate the document at length.
- Keep the document's main heading structure where it aids navigation.
- Do not introduce facts that aren't in the source — no outside knowledge.
- Do not distort numbers or proper nouns.
- one_line_summary describes the DOCUMENT (e.g. "RFP response from Midwest Beef Co
  outlining proposed pricing and delivery terms"), not its content.

Concept inventory (the `concepts` field):
- Also list the document's MAIN concepts — its key recurring themes — so a later
  stage can synthesise cross-document concept pages. Capture the real themes, not
  every minor mention: a list- or table-style doc (e.g. a table of supported
  types) still has only a few actual concepts, not one per row.
- For each concept give: `topic` (the subject matter), `subject` (the real-world
  entity it is a property OF — the product/system being documented, NOT this
  file), and a one-line `gloss` of what THIS document says about it.
- Name the subject as you find it in THIS document; a later stage reconciles
  subjects across the whole corpus (folding sub-components into their system,
  keeping distinct entities apart), so you don't need to guess the corpus shape.
- Two documents about the SAME topic and SAME subject describe one shared
  concept; the same topic about a DIFFERENT subject is a different concept.

Entity inventory (the `entities` + `edges` fields):
- Extract the named entities the document is ABOUT — things a reader would call
  a subject of the doc, not every named token. Give each a one-line `description`.
- Pick the closest `type`:
  - idea:    a concept, technique, algorithm, pattern, or methodology
  - service: a runnable system, product, command, external tool, or API
  - module:  a software component, library, or codebase subdivision
  - paper:   an external publication or citation (not a sibling doc)
  - person:  a real named human (not a role or job title)
  - event:   a specific occurrence at a point in time
- Do NOT extract config flags/env vars, schema vocabulary, file paths, individual
  functions of a library, boilerplate, or cross-references to sibling docs. One
  entity per concept (not per mention); one per library (not per function).
  When in doubt, skip.
- In `edges`, relate entities to each other by their `label`. Tier each edge by
  how the text supports it, then pick a `confidence_score` within the tier:
  EXTRACTED is always 1.0 (the text states it outright); INFERRED picks from
  0.55/0.65/0.75/0.85/0.95 (follows without being stated); AMBIGUOUS picks from
  0.1/0.15/0.2/0.25/0.3 (suspected, but real doubt). 0.5 is not a legal score.

- Return every field via the emit_page tool in a single call.
"""


def _parse_concepts(result: dict, source_sha: str) -> list[ConceptMention]:
    """Defensively parse the ``concepts`` array from an emit_page response into
    ConceptMentions, stamping the document's sha. Malformed/missing → []."""
    mentions: list[ConceptMention] = []
    for c in result.get("concepts") or []:
        if not isinstance(c, dict):
            continue
        topic = (c.get("topic") or "").strip()
        subject = (c.get("subject") or "").strip()
        gloss = (c.get("gloss") or "").strip()
        if topic and subject:
            mentions.append(ConceptMention(topic=topic, subject=subject, gloss=gloss, source_sha=source_sha))
    return mentions


def _title_from_filename(name: str) -> str:
    """Turn ``some-folder/midwest-beef-rfp-response.pdf`` into ``Midwest Beef Rfp Response``.

    Drops any directory components (users sometimes upload nested folders
    where the parent name is repeated across every file and would only add
    noise) and the file extension, then converts dashes/underscores to
    spaces and Title-Cases the result.
    """
    base = os.path.basename(name)
    stem, _ = os.path.splitext(base)
    cleaned = stem.replace("_", " ").replace("-", " ").strip() or "Untitled"
    return " ".join(part.capitalize() for part in cleaned.split())


def _qualify_title(base: str, name: str, used: set[str]) -> str:
    """Qualify *base* with directory context from *name* until unique vs *used*.

    ``docs/concepts/models.md`` → ``Models (concepts)``, widening to
    ``Models (docs/concepts)`` if a shallower hint still collides. Falls back to
    a numeric suffix when the path offers nothing more to distinguish on.
    *used* holds case-folded titles already taken.
    """
    dirs = [p for p in name.replace("\\", "/").split("/")[:-1] if p not in ("", ".", "..")]
    for depth in range(1, len(dirs) + 1):
        candidate = f"{base} ({'/'.join(dirs[-depth:])})"
        if candidate.casefold() not in used:
            return candidate
    n = 2
    while f"{base} ({n})".casefold() in used:
        n += 1
    return f"{base} ({n})"


def _disambiguated_titles(sources: list[NormalizedSource], existing_titles: set[str]) -> dict[str, str]:
    """Assign a unique display title to each file-summary page.

    The base title comes from the filename (``README.md`` → ``Readme``). The
    first claimant of a base title keeps it bare (mirroring how ``unique_slug``
    hands out ``readme`` then ``readme-2``); later collisions — whether against
    another source in this batch or an already-compiled file-summary page —
    are qualified with directory context (``Readme (docs)``,
    ``Readme (pydantic/internal)``) so a bare ``[[Readme]]`` wiki-link can't
    land on two pages and render broken. Returns ``{sha256: title}``.
    """
    base_by_sha = {s.sha256: _title_from_filename(s.original_name) for s in sources}

    assigned: dict[str, str] = {}
    used = {t.casefold() for t in existing_titles}
    # Deterministic order so the same corpus disambiguates identically every run.
    for s in sorted(sources, key=lambda s: (base_by_sha[s.sha256].casefold(), s.original_name)):
        base = base_by_sha[s.sha256]
        title = base if base.casefold() not in used else _qualify_title(base, s.original_name, used)
        used.add(title.casefold())
        assigned[s.sha256] = title
    return assigned


def _max_doc_chars() -> int:
    """Largest input document (in chars) we'll read in a single extraction call.

    A digest output is small, so the binding constraint is whether the document
    fits the model's input context — hence a generous fixed default that only
    enormous docs exceed. Override with ``OT_WIKI_MAX_DOC_CHARS`` (lower it for a
    small-context local model, or to force-split for testing).
    """
    override = os.environ.get("OT_WIKI_MAX_DOC_CHARS")
    if override:
        try:
            if (v := int(override)) > 0:
                return v
        except ValueError:
            pass
    return DEFAULT_MAX_DOC_CHARS


def _split_sections(md: str) -> list[str]:
    """Split markdown at heading boundaries, keeping each heading with its body.

    Any preamble before the first heading is its own section. A document with no
    headings comes back as a single section (the hard-splitter handles it).
    """
    starts = [m.start() for m in _HEADING_RE.finditer(md)]
    if not starts:
        return [md]
    sections: list[str] = []
    if starts[0] > 0:
        sections.append(md[: starts[0]])
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(md)
        sections.append(md[start:end])
    return sections


def _hard_split(text: str, max_chars: int) -> list[str]:
    """Last-resort splitter for a single section larger than *max_chars* — pack
    by paragraph, and char-window any paragraph that's still too big."""
    out: list[str] = []
    buf = ""
    for para in text.split("\n\n"):
        piece = para + "\n\n"
        if len(piece) > max_chars:
            if buf:
                out.append(buf)
                buf = ""
            out.extend(piece[i : i + max_chars] for i in range(0, len(piece), max_chars))
            continue
        if buf and len(buf) + len(piece) > max_chars:
            out.append(buf)
            buf = piece
        else:
            buf += piece
    if buf:
        out.append(buf)
    return out


def _chunk_markdown(md: str, max_chars: int) -> list[str]:
    """Split *md* into chunks no larger than *max_chars*, breaking on heading
    boundaries where possible. Returns ``[md]`` unchanged when it already fits."""
    if len(md) <= max_chars:
        return [md]
    chunks: list[str] = []
    buf = ""
    for sec in _split_sections(md):
        if len(sec) > max_chars:
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.extend(_hard_split(sec, max_chars))
            continue
        if buf and len(buf) + len(sec) > max_chars:
            chunks.append(buf)
            buf = sec
        else:
            buf += sec
    if buf:
        chunks.append(buf)
    return chunks


def _strip_leading_h1(body: str) -> str:
    """Drop a leading ``# Heading`` line so concatenated chunk bodies don't
    sprinkle the page with duplicate top-level headings."""
    stripped = body.lstrip("\n")
    head, _, rest = stripped.partition("\n")
    if head.startswith("# "):
        return rest.lstrip("\n")
    return body


def _merge_chunk_results(results: list[dict]) -> dict:
    """Merge per-chunk emit_page payloads into one document-level result.

    Bodies are concatenated (duplicate H1s dropped from later parts); the
    one-line summary is the first non-empty one; concepts/entities/edges are
    unioned with a light dedup so the doc's counts and downstream inputs aren't
    inflated by content that spanned a chunk boundary.
    """
    if len(results) == 1:
        return results[0]

    bodies = [str(r.get("markdown_body", "")) for r in results]
    merged_body = bodies[0].rstrip()
    for b in bodies[1:]:
        tail = _strip_leading_h1(b).strip()
        if tail:
            merged_body += "\n\n" + tail

    one_liner = next((s for r in results if (s := str(r.get("one_line_summary", "")).strip())), "")

    concepts: list[dict] = []
    seen_c: set[tuple[str, str]] = set()
    for r in results:
        for c in r.get("concepts") or []:
            if not isinstance(c, dict):
                continue
            key = ((c.get("topic") or "").strip().lower(), (c.get("subject") or "").strip().lower())
            if key == ("", "") or key in seen_c:
                continue
            seen_c.add(key)
            concepts.append(c)

    entities: list[dict] = []
    seen_e: set[tuple[str, str]] = set()
    for r in results:
        for e in r.get("entities") or []:
            if not isinstance(e, dict):
                continue
            key = ((e.get("type") or "").strip().lower(), (e.get("label") or "").strip().lower())
            if key[1] == "" or key in seen_e:
                continue
            seen_e.add(key)
            entities.append(e)

    edges: list[dict] = []
    seen_x: set[tuple[str, str, str]] = set()
    for r in results:
        for x in r.get("edges") or []:
            if not isinstance(x, dict):
                continue
            key = (
                (x.get("source") or "").strip().lower(),
                (x.get("target") or "").strip().lower(),
                (x.get("relation") or "").strip().lower(),
            )
            if "" in key[:2] or key in seen_x:
                continue
            seen_x.add(key)
            edges.append(x)

    return {
        "markdown_body": merged_body,
        "one_line_summary": one_liner,
        "concepts": concepts,
        "entities": entities,
        "edges": edges,
    }


def summarise_sources(
    sources: list[NormalizedSource],
    meta: VaultMetadata,
    llm: WikiLLM,
    out: list[CompiledPage],
    mentions_out: list[ConceptMention] | None = None,
    entity_nodes_out: list | None = None,
    entity_rels_out: list | None = None,
) -> Iterator[WikiPipelineEvent]:
    """Produce one file-summary page per newly-ingested source.

    The same call also inventories each document's concepts (qualified by
    topic + subject) and extracts the entity graph (typed entities + edges).
    When *mentions_out* / *entity_nodes_out* / *entity_rels_out* are given, the
    parsed ConceptMentions and entity nodes/edges are appended to them for the
    downstream Resolve and entity-merge stages. Folding concept + entity
    extraction into the summary call keeps the per-doc work to ONE LLM call.
    """
    total = len(sources)
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.SUMMARIZING_SOURCES,
        message=f"Summarising {total} source(s)",
        total=total,
    )

    seen_slugs: set[str] = set(meta.pages.keys())
    system = FILE_SUMMARY_SYSTEM

    # Resolve a unique title per source up front — duplicate filenames across
    # folders (README.md, index.md) would otherwise produce identical titles
    # and unresolvable [[Title]] links. Considers already-compiled
    # file-summary pages so re-runs don't reintroduce a clash.
    existing_ss_titles = {p.title for p in meta.pages.values() if p.kind == PAGE_KIND_FILE_SUMMARY}
    title_by_sha = _disambiguated_titles(sources, existing_ss_titles)

    max_chars = _max_doc_chars()

    def _summarise_one(src: NormalizedSource) -> tuple[NormalizedSource, str, dict, int]:
        title = title_by_sha[src.sha256]
        chunks = _chunk_markdown(src.markdown, max_chars)
        n = len(chunks)
        results: list[dict] = []
        for i, chunk in enumerate(chunks):
            # A faithful (near-verbatim) summary tracks input size, so a large
            # doc would overrun the per-backend output budget and truncate the
            # concept/entity fields that follow the body. We split such docs on
            # heading boundaries and summarise each part, then merge. Small docs
            # stay a single call (the common case).
            part_hint = (
                ""
                if n == 1
                else (
                    f"This is PART {i + 1} of {n} of a larger document (split for length). "
                    f"Summarise THIS part faithfully; the parts are concatenated into one page.\n\n"
                )
            )
            results.append(
                llm.call_tool(
                    system=system,
                    user=(
                        f"page_title: {title}\n\n"
                        f"Document filename: {src.original_name}\n\n"
                        f"{part_hint}"
                        f"Document body{f' (part {i + 1}/{n})' if n > 1 else ''}:\n{chunk}\n\n"
                        "Call emit_page."
                    ),
                    tool_name="emit_page",
                    tool_schema=FILE_SUMMARY_SCHEMA,
                    max_tokens=SUMMARY_MAX_TOKENS,
                )
            )
        return src, title, _merge_chunk_results(results), n

    # Each source is independent — generate concurrently. Emit a progress event
    # as each call COMPLETES (so the user sees live movement, not one burst at
    # the end), surfacing the per-doc entity + concept counts. Slug assignment
    # and page accumulation happen in a second pass in INPUT order so results
    # stay deterministic regardless of completion order.
    results_by_sha: dict[str, tuple[NormalizedSource, str, dict]] = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=_wiki_concurrency()) as pool:
        futures = [pool.submit(_summarise_one, src) for src in sources]
        for fut in concurrent.futures.as_completed(futures):
            src, title, result, n_parts = fut.result()
            results_by_sha[src.sha256] = (src, title, result)
            done += 1
            n_ent = len(result.get("entities") or []) if isinstance(result, dict) else 0
            n_con = len(result.get("concepts") or []) if isinstance(result, dict) else 0
            parts_note = f" ({n_parts} parts)" if n_parts > 1 else ""
            yield WikiPipelineEvent(
                kind=WikiEventKind.STAGE_PROGRESS,
                phase=WikiPhase.SUMMARIZING_SOURCES,
                message=f"Summarised {src.original_name} → {n_ent} entities, {n_con} concepts{parts_note}",
                current=done,
                total=total,
                file_name=src.original_name,
            )

    for src in sources:
        src, title, result = results_by_sha[src.sha256]
        if mentions_out is not None:
            mentions_out.extend(_parse_concepts(result, src.sha256))
        if entity_nodes_out is not None or entity_rels_out is not None:
            nodes, rels = build_entities(
                result,
                original_name=src.original_name,
                source_id=f"source::{src.sha256}",
                vault=meta.name,
            )
            if entity_nodes_out is not None:
                entity_nodes_out.extend(nodes)
            if entity_rels_out is not None:
                entity_rels_out.extend(rels)
        # The ``file-summary/`` directory in the slug is the namespace —
        # a concept and a file-summary page can share a title without
        # colliding because they live in different folders.
        slug = unique_slug(
            title,
            kind=PAGE_KIND_FILE_SUMMARY,
            existing=seen_slugs,
            tombstones=meta.tombstones,
        )
        seen_slugs.add(slug)
        out.append(
            CompiledPage(
                slug=slug,
                title=title,
                markdown_body=force_h1(str(result.get("markdown_body", "")), title),
                one_line_summary=str(result.get("one_line_summary", "")),
                source_shas=[src.sha256],
                revision=1,
                is_new=True,
                kind=PAGE_KIND_FILE_SUMMARY,
            )
        )

    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.SUMMARIZING_SOURCES,
        message=f"Produced {len(out)} file-summary page(s)",
        current=total,
        total=total,
    )
