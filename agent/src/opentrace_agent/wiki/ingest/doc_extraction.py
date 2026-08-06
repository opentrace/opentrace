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

"""DocExtraction stage — one LLM call per newly-ingested source.

Runs after Normalize. Each new document gets a single extraction call that
emits exactly one thing: a one-line summary. Together with the display title
(derived mechanically from the filename, no LLM) it becomes the
``KnowledgeDoc`` node's navigation label — what agents see in search hits and
listings before deciding to ``load_source`` the body.

There is no per-document wiki page and no synthesis. The raw
post-markitdown body lives in the corpus (``KnowledgeDoc.corpus_path``) and
is read directly by agents via the ``load_source`` MCP tool, or swept
verbatim via ``grep``.

The call asks for one field, deliberately. Fields in a single extraction
schema are not independent: each one competes with the others for the model's
attention on the same document. Do not add a second without measuring its
effect on the summary it would share the call with.
"""

from __future__ import annotations

import concurrent.futures
import os
import re
from collections.abc import Iterator

from opentrace_agent.wiki.ingest.types import (
    NormalizedSource,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
    _wiki_concurrency,
)
from opentrace_agent.wiki.llm import WikiLLM

# Output budget we request per extraction call. A one-liner is tiny, so this is
# modest; the client clamps it to the backend's hard cap
# (BackendConfig.max_output_tokens) regardless.
EXTRACTION_MAX_TOKENS = 4000

# Chunking: a doc must fit the model's INPUT context to be read in one
# extraction call. Since the extraction output is small, input — not the output
# budget — is the binding constraint, so the threshold is generous and the
# chunker is a rare safety net for enormous docs (not the common path). Override
# with OT_WIKI_MAX_DOC_CHARS (e.g. lower it for a small-context local model, or
# to force-split for testing).
DEFAULT_MAX_DOC_CHARS = 120_000
_HEADING_RE = re.compile(r"^#{1,6} ", re.MULTILINE)

DOC_EXTRACTION_SCHEMA = {
    "description": "Emit the one-line summary for a document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "one_line_summary": {
                "type": "string",
                "description": (
                    "One sentence describing the document — used as its navigation label in "
                    "listings and search results."
                ),
            },
        },
        "required": ["one_line_summary"],
    },
}


DOC_EXTRACTION_SYSTEM = """You are reading a single uploaded document for a document index.

The raw document is retained and readable in full, so you do NOT restate its
content. Your job is one line: a summary that serves as the document's
navigation label.

Hard rules:
- one_line_summary describes the DOCUMENT in one sentence (e.g. "RFP response
  from Midwest Beef Co outlining proposed pricing and delivery terms") — what a
  reader scanning a list would need to decide whether to open it.
- Describe what the document IS ABOUT; never restate what it CLAIMS as if the
  claim were fact. The label is a signpost to the document, not a substitute
  for reading it, and a document can be out of date or merely proposed.
  Write "Proposal for a token-bucket rate limiter on the public API", NOT
  "The public API rate-limits at 100 requests per second". Reach for
  describes / proposes / specifies / records rather than asserting the
  content in your own voice.
- Do not introduce facts that aren't in the source — no outside knowledge.
- Do not distort numbers or proper nouns.

- Return the summary via the emit_extraction tool in a single call.
"""


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


def _disambiguated_titles(sources: list[NormalizedSource]) -> dict[str, str]:
    """Assign a unique display title to each source.

    The base title comes from the filename (``README.md`` → ``Readme``). The
    first claimant of a base title keeps it bare; later collisions within the
    batch are qualified with directory context (``Readme (docs)``,
    ``Readme (pydantic/internal)``) so listings that show titles stay
    distinguishable. Returns ``{sha256: title}``.
    """
    base_by_sha = {s.sha256: _title_from_filename(s.original_name) for s in sources}

    assigned: dict[str, str] = {}
    used: set[str] = set()
    # Deterministic order so the same corpus disambiguates identically every run.
    for s in sorted(sources, key=lambda s: (base_by_sha[s.sha256].casefold(), s.original_name)):
        base = base_by_sha[s.sha256]
        title = base if base.casefold() not in used else _qualify_title(base, s.original_name, used)
        used.add(title.casefold())
        assigned[s.sha256] = title
    return assigned


def _max_doc_chars() -> int:
    """Largest input document (in chars) we'll read in a single extraction call.

    The extraction output is small, so the binding constraint is whether the
    document fits the model's input context — hence a generous fixed default
    that only enormous docs exceed. Override with ``OT_WIKI_MAX_DOC_CHARS``
    (lower it for a small-context local model, or to force-split for testing).
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


def _merge_chunk_results(results: list[dict]) -> dict:
    """Merge per-chunk emit_extraction payloads into one document-level result.

    The document-level one-line summary is the first non-empty one — a chunk
    is a slice of the same document, so the first chunk that produced a label
    already describes it.
    """
    if len(results) == 1:
        return results[0]

    one_liner = next((s for r in results if (s := str(r.get("one_line_summary", "")).strip())), "")
    return {"one_line_summary": one_liner}


def extract_docs(
    sources: list[NormalizedSource],
    llm: WikiLLM,
) -> Iterator[WikiPipelineEvent]:
    """Run the per-doc extraction call for each newly-ingested source.

    Stamps ``title`` + ``one_line_summary`` onto each ``NormalizedSource``
    in place (the graph writer copies them onto the ``KnowledgeDoc`` node as
    its navigation label). ONE LLM call per document, one field out of it.
    """
    total = len(sources)
    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_START,
        phase=WikiPhase.EXTRACTING,
        message=f"Extracting from {total} source(s)",
        total=total,
    )

    system = DOC_EXTRACTION_SYSTEM

    # Resolve a unique title per source up front — duplicate filenames across
    # folders (README.md, index.md) would otherwise produce identical labels
    # and indistinguishable listings.
    title_by_sha = _disambiguated_titles(sources)

    max_chars = _max_doc_chars()

    def _extract_one(src: NormalizedSource) -> tuple[NormalizedSource, str, dict, int]:
        title = title_by_sha[src.sha256]
        chunks = _chunk_markdown(src.markdown, max_chars)
        n = len(chunks)
        results: list[dict] = []
        for i, chunk in enumerate(chunks):
            # A doc must fit the model's input context to be read in one call.
            # We split oversized docs on heading boundaries, extract from each
            # part, and merge. Small docs stay a single call (the common case).
            part_hint = (
                ""
                if n == 1
                else (
                    f"This is PART {i + 1} of {n} of a larger document (split for length). "
                    f"Inventory THIS part; the parts are merged into one document-level result.\n\n"
                )
            )
            results.append(
                llm.call_tool(
                    system=system,
                    user=(
                        f"Document title: {title}\n\n"
                        f"Document filename: {src.original_name}\n\n"
                        f"{part_hint}"
                        f"Document body{f' (part {i + 1}/{n})' if n > 1 else ''}:\n{chunk}\n\n"
                        "Call emit_extraction."
                    ),
                    tool_name="emit_extraction",
                    tool_schema=DOC_EXTRACTION_SCHEMA,
                    max_tokens=EXTRACTION_MAX_TOKENS,
                )
            )
        return src, title, _merge_chunk_results(results), n

    # Each source is independent — extract concurrently. Emit a progress event
    # as each call COMPLETES (so the user sees live movement, not one burst at
    # the end). Label stamping happens in a second pass in INPUT order so
    # results stay deterministic regardless of completion order.
    results_by_sha: dict[str, tuple[NormalizedSource, str, dict]] = {}
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=_wiki_concurrency()) as pool:
        futures = [pool.submit(_extract_one, src) for src in sources]
        for fut in concurrent.futures.as_completed(futures):
            src, title, result, n_parts = fut.result()
            results_by_sha[src.sha256] = (src, title, result)
            done += 1
            parts_note = f" ({n_parts} parts)" if n_parts > 1 else ""
            yield WikiPipelineEvent(
                kind=WikiEventKind.STAGE_PROGRESS,
                phase=WikiPhase.EXTRACTING,
                message=f"Extracted {src.original_name}{parts_note}",
                current=done,
                total=total,
                file_name=src.original_name,
            )

    for src in sources:
        src, title, result = results_by_sha[src.sha256]
        src.title = title
        src.one_line_summary = str(result.get("one_line_summary", ""))

    yield WikiPipelineEvent(
        kind=WikiEventKind.STAGE_STOP,
        phase=WikiPhase.EXTRACTING,
        message=f"Extracted labels from {total} doc(s)",
        current=total,
        total=total,
    )
