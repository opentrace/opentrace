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

"""SummariseSources stage — one source-summary page per newly-ingested source.

Runs after Normalize, before Plan. Each new source becomes a page titled
``Source Summary: <Display Name>`` that's a faithful summary of just that
document. Concept pages produced by the later Execute stage cite source
summaries by ``[[Source Summary: …]]`` wiki-link, giving inline provenance
for any factual claim. The original source files (PDFs, etc.) are NOT
retained — these summaries are the only on-disk record of source content.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

from opentrace_agent.wiki.ingest.types import (
    PAGE_KIND_SOURCE_SUMMARY,
    CompiledPage,
    NormalizedSource,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.llm import WikiLLM
from opentrace_agent.wiki.slugify import unique_slug
from opentrace_agent.wiki.vault import VaultMetadata


SOURCE_SUMMARY_SCHEMA = {
    "description": "Emit the markdown body and one-line summary for a source-summary page.",
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
        },
        "required": ["markdown_body", "one_line_summary"],
    },
}


SOURCE_SUMMARY_SYSTEM = """You are summarising a single uploaded document into a wiki page.

This page sits alongside concept pages in a knowledge vault. Concept pages
will cite this page as their citation target, so be FAITHFUL to the source:

Hard rules:
- The first line MUST be an H1 equal to the supplied page_title.
- Preserve every meaningful fact, every named entity, and every numeric figure
  (dates, dollar amounts, specifications, IDs) verbatim.
- Preserve the document's heading structure where possible.
- Do not introduce facts that aren't in the source — no outside knowledge.
- Do not paraphrase numbers or proper nouns beyond recognition.
- one_line_summary describes the DOCUMENT (e.g. "RFP response from Midwest Beef Co
  outlining proposed pricing and delivery terms"), not its content.
- Return both fields via the emit_page tool.
"""


def _title_from_filename(name: str) -> str:
    """Turn ``midwest-beef-rfp-response.pdf`` into ``Source Summary: Midwest Beef Rfp Response``."""
    stem, _ = os.path.splitext(name)
    cleaned = stem.replace("_", " ").replace("-", " ").strip() or "Untitled"
    titled = " ".join(part.capitalize() for part in cleaned.split())
    return f"Source Summary: {titled}"


def summarise_sources(
    sources: list[NormalizedSource],
    meta: VaultMetadata,
    llm: WikiLLM,
    out: list[CompiledPage],
) -> Iterator[WikiPipelineEvent]:
    """Produce one source-summary page per newly-ingested source."""
    total = len(sources)
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.SUMMARIZING_SOURCES,
        message=f"Summarising {total} source(s)",
        total=total,
    )

    seen_slugs: set[str] = set(meta.pages.keys())
    for i, src in enumerate(sources, start=1):
        title = _title_from_filename(src.original_name)
        result = llm.call_tool(
            system=SOURCE_SUMMARY_SYSTEM,
            user=(
                f"page_title: {title}\n\n"
                f"Document filename: {src.original_name}\n\n"
                f"Document body:\n{src.markdown}\n\n"
                "Call emit_page."
            ),
            tool_name="emit_page",
            tool_schema=SOURCE_SUMMARY_SCHEMA,
            max_tokens=8192,
        )
        slug = unique_slug(title, existing=seen_slugs, tombstones=meta.tombstones)
        seen_slugs.add(slug)
        out.append(
            CompiledPage(
                slug=slug,
                title=title,
                markdown_body=str(result.get("markdown_body", "")),
                one_line_summary=str(result.get("one_line_summary", "")),
                source_shas=[src.sha256],
                revision=1,
                is_new=True,
                kind=PAGE_KIND_SOURCE_SUMMARY,
            )
        )
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_PROGRESS,
            phase=WikiPhase.SUMMARIZING_SOURCES,
            message=f"Summarised {src.original_name}",
            current=i,
            total=total,
            file_name=slug,
        )

    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.SUMMARIZING_SOURCES,
        message=f"Produced {len(out)} source-summary page(s)",
        current=total,
        total=total,
    )
