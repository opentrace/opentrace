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

"""Execute stage — per-action LLM calls that emit page markdown + summary."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from opentrace_agent.wiki.ingest.types import (
    CompiledPage,
    NormalizedSource,
    Plan,
    PlanCreate,
    PlanExtend,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.llm import WikiLLM
from opentrace_agent.wiki.slugify import unique_slug
from opentrace_agent.wiki.vault import VaultMetadata

EMIT_PAGE_SCHEMA = {
    "description": "Emit the markdown body and one-line summary for a wiki page.",
    "input_schema": {
        "type": "object",
        "properties": {
            "markdown_body": {
                "type": "string",
                "description": ("Full markdown content for the page, starting with an H1 equal to the page title."),
            },
            "one_line_summary": {
                "type": "string",
                "description": "A single-sentence summary used in the vault index.",
            },
        },
        "required": ["markdown_body", "one_line_summary"],
    },
}

CREATE_SYSTEM = """You write a single page of a markdown wiki.

This is a CONCEPT page that synthesises across multiple sources. The vault
also contains SOURCE-SUMMARY pages — one-per-uploaded-document summaries
with titles that start with "Source Summary: ". When you state a fact drawn
from a particular source, cite it inline with [[Source Summary: <Title>]]
after the relevant sentence so readers can audit your claims.

Rules:
- The first line of markdown_body MUST be an H1 equal to the supplied page_title (no leading frontmatter).
- Use [[Page Title]] to reference any concept that appears in the supplied neighbour pages — match the title verbatim.
- For factual claims, cite the source-summary page with [[Source Summary: <Title>]] using the verbatim title from the neighbour list.
- Do NOT invent links to titles that aren't in the neighbour list.
- Keep prose factual and grounded in the supplied source documents.
- one_line_summary should be a single declarative sentence, < 200 chars.
- Return both markdown_body and one_line_summary via the emit_page tool.
"""

EXTEND_SYSTEM = """You revise a single page of a markdown wiki.

This is a CONCEPT page. Source-summary pages (titles starting with
"Source Summary: ") in the neighbour list are citation targets — when you
add a fact from a specific source, cite it inline with
[[Source Summary: <Title>]].

Rules:
- Preserve the existing factual content unless the new sources directly contradict it.
- Merge the new sources' contributions into the existing structure.
- Keep the H1 from the existing page.
- Update or add [[Page Title]] links as needed; only link to titles in the supplied neighbour list.
- For factual claims drawn from a specific source, cite the source-summary page with [[Source Summary: <Title>]].
- Do not duplicate facts — integrate, don't append.
- one_line_summary should reflect the post-merge state.
- Return the FULL replacement page via the emit_page tool — markdown_body must be a complete page, not a diff.
"""


def _neighbour_block(
    meta: VaultMetadata,
    exclude_slug: str | None = None,
    *,
    pending_creates: list[PlanCreate] | None = None,
    exclude_title: str | None = None,
) -> str:
    """Render the list of titles the LLM is allowed to link to via [[Title]].

    Includes both already-persisted pages from *meta.pages* and any
    *pending_creates* — pages decided in this same batch that haven't been
    persisted yet. Without the pending entries, a fresh-vault compile that
    creates several pages at once produces zero wiki-links because every
    Execute call sees an empty neighbour list.
    """
    lines: list[str] = []
    for p in meta.pages.values():
        if p.slug == exclude_slug:
            continue
        lines.append(f"- {p.title}: {p.one_line_summary}")
    if pending_creates:
        for c in pending_creates:
            if c.title == exclude_title:
                continue
            summary = c.rationale or "(being created in this batch)"
            lines.append(f"- {c.title}: {summary}")
    if not lines:
        return "(no neighbour pages)"
    return "Neighbour pages (link as [[Title]]):\n" + "\n".join(lines)


def _sources_block(sources: list[NormalizedSource], shas: list[str]) -> str:
    by_sha = {s.sha256: s for s in sources}
    blocks = []
    for sha in shas:
        s = by_sha.get(sha)
        if s is None:
            continue
        blocks.append(f"--- {s.original_name} ---\n{s.markdown}")
    return "\n\n".join(blocks)


def _execute_create(
    item: PlanCreate,
    sources: list[NormalizedSource],
    meta: VaultMetadata,
    pending_creates: list[PlanCreate],
    llm: WikiLLM,
) -> CompiledPage:
    user_msg = (
        f"page_title: {item.title}\n\n"
        f"{_neighbour_block(meta, pending_creates=pending_creates, exclude_title=item.title)}\n\n"
        f"Source documents:\n{_sources_block(sources, item.source_shas)}\n\n"
        "Call emit_page."
    )
    result = llm.call_tool(
        system=CREATE_SYSTEM,
        user=user_msg,
        tool_name="emit_page",
        tool_schema=EMIT_PAGE_SCHEMA,
        max_tokens=8192,
    )
    slug = unique_slug(
        item.title,
        existing=meta.pages.keys(),
        tombstones=meta.tombstones,
    )
    return CompiledPage(
        slug=slug,
        title=item.title,
        markdown_body=str(result.get("markdown_body", "")),
        one_line_summary=str(result.get("one_line_summary", "")),
        source_shas=list(item.source_shas),
        revision=1,
        is_new=True,
    )


def _execute_extend(
    item: PlanExtend,
    sources: list[NormalizedSource],
    meta: VaultMetadata,
    pages_dir: Path,
    pending_creates: list[PlanCreate],
    llm: WikiLLM,
) -> CompiledPage | None:
    page_meta = meta.pages.get(item.page_slug)
    if page_meta is None:
        return None
    page_path = pages_dir / f"{page_meta.slug}.md"
    existing_body = page_path.read_text() if page_path.exists() else ""
    user_msg = (
        f"page_title: {page_meta.title}\n"
        f"page_slug: {page_meta.slug}\n\n"
        f"Existing page markdown:\n{existing_body}\n\n"
        f"{_neighbour_block(meta, exclude_slug=page_meta.slug, pending_creates=pending_creates)}\n\n"
        f"Plan rationale: {item.rationale}\n\n"
        f"New source documents to merge in:\n{_sources_block(sources, item.source_shas)}\n\n"
        "Call emit_page with the FULL replacement page."
    )
    result = llm.call_tool(
        system=EXTEND_SYSTEM,
        user=user_msg,
        tool_name="emit_page",
        tool_schema=EMIT_PAGE_SCHEMA,
        max_tokens=8192,
    )
    new_shas = list(dict.fromkeys([*page_meta.source_shas, *item.source_shas]))
    return CompiledPage(
        slug=page_meta.slug,
        title=page_meta.title,
        markdown_body=str(result.get("markdown_body", "")),
        one_line_summary=str(result.get("one_line_summary", page_meta.one_line_summary)),
        source_shas=new_shas,
        revision=page_meta.revision + 1,
        is_new=False,
    )


def execute(
    p: Plan,
    sources: list[NormalizedSource],
    meta: VaultMetadata,
    pages_dir: Path,
    llm: WikiLLM,
    out: list[CompiledPage],
) -> Iterator[WikiPipelineEvent]:
    """Run an LLM call per action; populate *out* with compiled pages."""
    total = len(p.creates) + len(p.extends)
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.EXECUTING,
        message=f"Executing {total} action(s)",
        total=total,
    )
    done = 0
    seen_slugs: set[str] = set(meta.pages.keys())
    for create in p.creates:
        page = _execute_create(create, sources, meta, p.creates, llm)
        # Resolve collisions live in case multiple creates share a base slug this batch.
        if page.slug in seen_slugs:
            page = CompiledPage(
                slug=unique_slug(page.title, existing=seen_slugs, tombstones=meta.tombstones),
                title=page.title,
                markdown_body=page.markdown_body,
                one_line_summary=page.one_line_summary,
                source_shas=page.source_shas,
                revision=page.revision,
                is_new=page.is_new,
            )
        seen_slugs.add(page.slug)
        out.append(page)
        done += 1
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_PROGRESS,
            phase=WikiPhase.EXECUTING,
            message=f"Created {page.title}",
            current=done,
            total=total,
            file_name=page.slug,
        )
    for extend in p.extends:
        page = _execute_extend(extend, sources, meta, pages_dir, p.creates, llm)
        if page is None:
            continue
        out.append(page)
        done += 1
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_PROGRESS,
            phase=WikiPhase.EXECUTING,
            message=f"Extended {page.title} (rev {page.revision})",
            current=done,
            total=total,
            file_name=page.slug,
        )
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.EXECUTING,
        message=f"Executed {done} action(s)",
        current=done,
        total=total,
    )
