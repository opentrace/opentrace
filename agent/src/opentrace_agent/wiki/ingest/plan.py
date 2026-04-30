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

"""Plan stage — one LLM call that emits the create/extend plan."""

from __future__ import annotations

import logging
from collections.abc import Iterator

logger = logging.getLogger(__name__)

from opentrace_agent.wiki.index import IndexEntry, build_index, estimate_tokens
from opentrace_agent.wiki.ingest.extract import extract_salient_terms
from opentrace_agent.wiki.ingest.types import (
    CompiledPage,
    NormalizedSource,
    Plan,
    PlanCreate,
    PlanExtend,
    VaultIndexTooLarge,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.llm import WikiLLM
from opentrace_agent.wiki.vault import VaultMetadata

MAX_PLAN_INDEX_TOKENS = 150_000

PLAN_TOOL_SCHEMA = {
    "description": "Propose a plan: which new pages to create and which existing pages to extend.",
    "input_schema": {
        "type": "object",
        "properties": {
            "creates": {
                "type": "array",
                "description": "Pages to create from scratch.",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "source_shas": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "SHAs of sources contributing to this page.",
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": ["title", "source_shas"],
                },
            },
            "extends": {
                "type": "array",
                "description": "Existing pages to extend with new content.",
                "items": {
                    "type": "object",
                    "properties": {
                        "page_slug": {
                            "type": "string",
                            "description": "Slug of the existing page (must match the index).",
                        },
                        "source_shas": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                        "rationale": {"type": "string"},
                    },
                    "required": ["page_slug", "source_shas"],
                },
            },
        },
        "required": ["creates", "extends"],
    },
}

PLAN_SYSTEM = """You are the planner for a markdown knowledge wiki.

You receive:
1. The current vault index — slug, title, one-line summary per existing page.
   Pages whose title starts with "Source Summary: " are SOURCE-SUMMARY PAGES —
   one-per-uploaded-document summaries that already exist. The remaining pages are
   CONCEPT PAGES — synthesis pages that draw across multiple sources.
2. A batch of new source content. Each source is shown via its freshly-created
   source-summary body plus a flat list of "Salient terms from raw text"
   (regex-extracted entities/headings from the original document, kept so a planner
   can spot cross-source long-tail terms the summary may have compressed away).

You are deciding only what CONCEPT pages to add or extend. Source-summary pages
are auto-generated upstream and you must NOT propose them as creates.

Decide for each recurring concept across the new sources whether it belongs in:
- a NEW concept page (creates), if no existing concept page covers it; or
- an EXTEND of an existing concept page (extends), if the concept overlaps.

Hard rules:
- Prefer EXTEND when an existing CONCEPT page already covers the concept.
- For EXTEND, page_slug MUST match a slug in the supplied index. Never invent slugs.
- Do NOT propose creates for source-summary pages — they're auto-generated.
- For CREATE, titles must not semantically duplicate each other or existing index titles.
- Concept pages must SYNTHESISE across sources — if only one source contributes,
  prefer NOT creating a concept page (the source-summary page already covers it).
- Each source_sha you cite MUST appear in the supplied new sources list.
- Output MUST be returned via the propose_plan tool.
"""


def _format_index(entries: list[IndexEntry]) -> str:
    if not entries:
        return "(empty vault — no existing pages)"
    lines = ["Existing pages (slug | title | summary):"]
    for e in entries:
        lines.append(f"- {e.slug} | {e.title} | {e.one_line_summary}")
    return "\n".join(lines)


def _format_sources(
    sources: list[NormalizedSource],
    source_summaries_by_sha: dict[str, CompiledPage],
) -> str:
    """Render the new-sources block for the Plan prompt.

    Each source contributes its source-summary body plus a deterministic
    extraction of salient terms from the raw markdown (cheap insurance
    against summarizer drift on cross-source long-tail entities).

    The full SHA is included verbatim — the server-side filter validates
    that returned ``source_shas`` match ones we sent, so a truncated form
    would silently drop every proposal.
    """
    blocks = []
    for s in sources:
        ss = source_summaries_by_sha[s.sha256]
        terms = extract_salient_terms(s.markdown)
        terms_block = (
            f"Salient terms from raw text:\n{', '.join(terms)}"
            if terms
            else "Salient terms from raw text: (none extracted)"
        )
        blocks.append(f"--- source summary: {ss.title} (sha={s.sha256}) ---\n{ss.markdown_body}\n\n{terms_block}")
    return "\n\n".join(blocks)


def plan(
    sources: list[NormalizedSource],
    meta: VaultMetadata,
    llm: WikiLLM,
    out: list[Plan],
    *,
    source_summaries_by_sha: dict[str, CompiledPage],
) -> Iterator[WikiPipelineEvent]:
    """Run a single Plan LLM call and append the resulting plan to *out*."""
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.PLANNING,
        message="Planning vault changes",
    )

    index_entries = build_index(meta)
    estimated = estimate_tokens(index_entries)
    if estimated > MAX_PLAN_INDEX_TOKENS:
        raise VaultIndexTooLarge(
            f"Vault index estimated at ~{estimated} tokens, exceeds {MAX_PLAN_INDEX_TOKENS}. "
            "Chunked planning is deferred to v2."
        )

    user_msg = (
        f"{_format_index(index_entries)}\n\n"
        f"New sources to ingest:\n"
        f"{_format_sources(sources, source_summaries_by_sha)}\n\n"
        "Call propose_plan with your decisions."
    )

    result = llm.call_tool(
        system=PLAN_SYSTEM,
        user=user_msg,
        tool_name="propose_plan",
        tool_schema=PLAN_TOOL_SCHEMA,
        max_tokens=4096,
    )

    new_shas = {s.sha256 for s in sources}
    existing_slugs = {e.slug for e in index_entries}

    raw_creates = result.get("creates", []) or []
    raw_extends = result.get("extends", []) or []

    creates: list[PlanCreate] = []
    for c in raw_creates:
        title = (c.get("title") or "").strip()
        shas = [sha for sha in (c.get("source_shas") or []) if sha in new_shas]
        if title and shas:
            creates.append(PlanCreate(title=title, source_shas=shas, rationale=c.get("rationale", "")))
        else:
            logger.warning(
                "plan: dropping create %r — title=%r, returned_shas=%s, valid_shas=%s",
                c,
                title,
                c.get("source_shas"),
                shas,
            )

    extends: list[PlanExtend] = []
    for x in raw_extends:
        slug = (x.get("page_slug") or "").strip()
        shas = [sha for sha in (x.get("source_shas") or []) if sha in new_shas]
        if slug in existing_slugs and shas:
            extends.append(PlanExtend(page_slug=slug, source_shas=shas, rationale=x.get("rationale", "")))
        else:
            logger.warning(
                "plan: dropping extend %r — slug=%r in_index=%s, returned_shas=%s, valid_shas=%s",
                x,
                slug,
                slug in existing_slugs,
                x.get("source_shas"),
                shas,
            )

    if (raw_creates or raw_extends) and not (creates or extends):
        logger.warning(
            "plan: LLM returned %d creates / %d extends but ALL were filtered — "
            "check that returned source_shas match the SHAs we sent",
            len(raw_creates),
            len(raw_extends),
        )

    p = Plan(creates=creates, extends=extends)
    out.append(p)

    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.PLANNING,
        message=f"Plan: {len(creates)} create, {len(extends)} extend",
        detail={"creates": len(creates), "extends": len(extends)},
    )
