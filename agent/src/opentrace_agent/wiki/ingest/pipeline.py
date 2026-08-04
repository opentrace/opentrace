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

"""Five-stage compilation composer — public ``run_compile`` entrypoint."""

from __future__ import annotations

import contextlib
import logging
import os
import uuid
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

from opentrace_agent.sources._llm_common import resolve_model
from opentrace_agent.wiki.ingest.doc_extraction import extract_docs as _extract_docs
from opentrace_agent.wiki.ingest.graph_writer import write_vault_to_graph
from opentrace_agent.wiki.ingest.normalize import normalize as _normalize
from opentrace_agent.wiki.ingest.persist import persist as _persist
from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.ingest.sources import acquire as _acquire
from opentrace_agent.wiki.ingest.types import (
    NormalizedSource,
    SourceInput,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
    _wiki_concurrency,
)
from opentrace_agent.wiki.llm import (
    PROVIDER_ANTHROPIC,
    AdaptiveLimiter,
    WikiLLM,
    make_llm,
)
from opentrace_agent.wiki.paths import (
    compile_log_dir,
    ensure_vault_layout,
    metadata_path,
    pages_dir,
)
from opentrace_agent.wiki.vault import (
    VaultMetadata,
    load_metadata,
)

logger = logging.getLogger(__name__)


def _min_doc_chars() -> int:
    """Minimum extracted-markdown length for a source to be ingested
    (``OT_WIKI_MIN_DOC_CHARS``, default 10). A content gate, not a type gate:
    logos/favicons/icons normalize to ~empty and are dropped, while any image
    whose text/data IS extracted clears the bar and flows through like a doc."""
    raw = os.environ.get("OT_WIKI_MIN_DOC_CHARS", "").strip()
    try:
        return max(0, int(raw)) if raw else 10
    except ValueError:
        return 10


@contextlib.contextmanager
def _flock(path: Path):
    """Best-effort exclusive lock on *path* using fcntl when available."""
    try:
        import fcntl
    except ImportError:
        # Non-POSIX; skip locking.
        yield
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    # Use a sibling lock file so we don't have to worry about parsing an
    # empty/seeded metadata JSON. The lock file is purely advisory.
    lock_path = path.with_name(path.name + ".lock")
    lock_path.touch(exist_ok=True)
    fp = lock_path.open("r+b")
    try:
        try:
            fcntl.flock(fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise RuntimeError(f"vault {path.parent.name!r} is busy — another compile is in progress") from e
        try:
            yield
        finally:
            fcntl.flock(fp.fileno(), fcntl.LOCK_UN)
    finally:
        fp.close()


def run_compile(
    vault_name: str,
    inputs: Iterable[SourceInput],
    *,
    api_key: str | None = None,
    provider: str = PROVIDER_ANTHROPIC,
    model: str | None = None,
    base_url: str | None = None,
    vault_root: Path | str | None = None,
    scope: str = "local",
    project_root: Path | str | None = None,
    llm: WikiLLM | None = None,
    graph_store: Any = None,
) -> Iterator[WikiPipelineEvent]:
    """Compile uploaded files into the named vault.

    ``scope`` selects ``"local"`` (vault lives at ``<project_root>/
    .opentrace/vaults/<name>/`` — default; visible only to graphs that share
    the project root) or ``"global"`` (vault lives at ``~/.opentrace/
    vaults/<name>/`` — visible to any graph on the machine via
    ``opentraceai vault attach``). *vault_root* overrides both, mostly for
    tests.

    Yields :class:`WikiPipelineEvent` for each progress step. Per-vault
    concurrency is serialized via ``fcntl.flock``; a second concurrent
    call raises.

    ``provider`` selects the LLM backend (one of ``"anthropic"``, ``"gemini"``,
    ``"openai"``, ``"local"``). ``base_url`` is only used when ``provider``
    is ``"local"``. ``llm`` is provided for tests; when set,
    ``provider``/``api_key``/``model``/``base_url`` are ignored.

    When ``graph_store`` is supplied, the post-compile vault state is
    mirrored into the graph as a separate step *after* disk writes succeed.
    Failures during the graph write are caught and surfaced as a warning
    event so the on-disk vault stays valid even if the graph mirror falls
    behind. Re-sync from disk via ``opentraceai vault attach``.

    The compile is **corpus-only**: documents are indexed (KnowledgeDoc nodes
    with navigation labels and epistemic status, doc↔doc
    links, MIRRORS twins) and read back raw via ``load_source`` or swept
    verbatim by ``grep``. Nothing is synthesized. Concept-page synthesis was
    removed — it measured 88.4% against a 98.6% control (-10.2pp, the worst
    result on record) because restating a source strips its hedges, tense,
    and attribution, a failure mode a verbatim body structurally cannot have.
    """
    ensure_vault_layout(vault_name, vault_root, scope=scope, project_root=project_root)
    meta_path = metadata_path(vault_name, vault_root, scope=scope, project_root=project_root)
    pages_path = pages_dir(vault_name, vault_root, scope=scope, project_root=project_root)
    log_path = compile_log_dir(vault_name, vault_root, scope=scope, project_root=project_root)

    with _flock(meta_path):
        meta = load_metadata(meta_path, name=vault_name)
        # Stamp the name in case the file was just created.
        if meta.name != vault_name:
            meta.name = vault_name

        # Acquire
        acquired: list[AcquiredSource] = []
        yield from _acquire(inputs, meta, acquired)

        if not acquired:
            yield WikiPipelineEvent(
                kind=WikiEventKind.DONE,
                phase=WikiPhase.PERSISTING,
                message="No new sources — vault unchanged",
            )
            return

        # Normalize
        normalized: list[NormalizedSource] = []
        yield from _normalize(acquired, normalized)

        # Content gate: drop sources whose extracted markdown is empty/trivial
        # (logos, favicons, icons → markitdown yields ~nothing). This is
        # content-based, not type-based — an image whose text/data IS extracted
        # clears the bar and is ingested like any doc. Filter `acquired` to
        # match so the dropped sources get no Source node / corpus / meta entry.
        min_chars = _min_doc_chars()
        before = len(normalized)
        normalized[:] = [s for s in normalized if len(s.markdown.strip()) >= min_chars]
        if len(normalized) != before:
            kept_shas = {s.sha256 for s in normalized}
            acquired[:] = [a for a in acquired if a.sha256 in kept_shas]
            yield WikiPipelineEvent(
                kind=WikiEventKind.STAGE_PROGRESS,
                phase=WikiPhase.NORMALIZING,
                message=f"Skipped {before - len(normalized)} empty/low-content source(s) (< {min_chars} chars)",
                detail={"low_content_skipped": before - len(normalized)},
            )

        if not normalized:
            yield WikiPipelineEvent(
                kind=WikiEventKind.DONE,
                phase=WikiPhase.NORMALIZING,
                message="All sources empty or failed normalization — vault unchanged",
            )
            return

        # Persist normalized markdown to the corpus so re-extraction and
        # grep can work over raw sources after the in-memory bytes are
        # gone. Always runs — corpus is independent of whether this
        # compile is mirroring to a graph store. Failures are non-fatal.
        #
        # Corpus location depends on the run:
        # * mirroring to a graph store → ``<db_dir>/corpus/`` so the
        #   ``Source.corpus_path`` value (which is read relative to
        #   ``<db_dir>``) resolves on disk.
        # * disk-only (e.g. compiling a global vault that hasn't been
        #   attached anywhere yet) → the scope's well-known dir, so a
        #   later ``vault attach`` can copy the bodies into a project.
        from opentrace_agent.sources.markdown import (
            corpus_dir as corpus_dir_for_db,
        )
        from opentrace_agent.sources.markdown import (
            corpus_dir_for_scope,
            write_corpus_markdown_to,
        )

        if graph_store is not None and getattr(graph_store, "db_path", None):
            cdir = corpus_dir_for_db(graph_store.db_path)
        else:
            cdir = corpus_dir_for_scope(scope, project_root=project_root)
        for src in normalized:
            try:
                src.corpus_path = write_corpus_markdown_to(cdir, src.sha256, src.markdown)
            except OSError as e:
                yield WikiPipelineEvent(
                    kind=WikiEventKind.STAGE_PROGRESS,
                    phase=WikiPhase.NORMALIZING,
                    message=f"⚠ Corpus write failed for {src.original_name}: {e}",
                    file_name=src.original_name,
                )

        # Per-doc extraction is a compact inventory, so it runs on the cheap
        # tier by default (role="wiki_summary", overridable via
        # OT_WIKI_SUMMARY_MODEL). An explicit *model* from the caller wins — it
        # used to reach only the flagship synthesis client, which no longer
        # makes any call, so honouring it here is what keeps `--model` from
        # being silently inert. When a caller injects `llm` (tests), use it.
        extraction_model = model or resolve_model(provider, None, role="wiki_summary")
        extraction_client: WikiLLM = llm or make_llm(
            provider,
            api_key=api_key,
            model=extraction_model,
            base_url=base_url,
        )

        # Adaptive limiter: starts at OT_WIKI_CONCURRENCY and ratchets down on
        # provider throttling so a high default stays safe on low API tiers.
        # Only wired for real backends — an injected `llm` (tests) gates via
        # the ThreadPoolExecutor alone.
        if llm is None:
            extraction_client._limiter = AdaptiveLimiter(_wiki_concurrency())  # type: ignore[attr-defined]

        # Per-doc extraction — stamps each source's navigation label (title +
        # one-liner, mirrored onto its KnowledgeDoc node). That is the whole
        # stage: no per-document wiki pages and no entity inventory, so the
        # raw body in the corpus (readable via load_source, greppable
        # verbatim) is the only representation of the document's content.
        yield from _extract_docs(normalized, meta, extraction_client)

        # Persist. Always zero pages now (synthesis was removed) — but the
        # acquired sources and their metadata still need recording (persist
        # updates meta.sources, including the extraction-stamped labels), and
        # the graph mirror below still needs the KnowledgeDoc nodes and labels.
        yield from _persist([], acquired, meta, pages_path, meta_path, log_path, normalized=normalized)

        # Mirror the post-compile state into the graph if a store is given.
        # Disk-write has already succeeded, so failures here are non-fatal.
        if graph_store is not None:
            try:
                page_bodies = _read_all_page_bodies(meta, pages_path)
                # Provenance: stamp agent/model/session on pages produced
                # this run. Pages not touched this run preserve whatever
                # provenance the graph already has. ``confidence`` /
                # ``confidence_tier`` are set per-page by graph_writer
                # (concept pages → INFERRED) — see _confidence_for_kind there.
                provenance = {
                    "agent": "opentrace-wiki-compiler",
                    "model": extraction_model,
                    "session": str(uuid.uuid4()),
                }
                # No pages are compiled any more, so none get fresh provenance
                # stamped; legacy pages keep whatever they already carry.
                compiled_slugs: set[str] = set()
                stats = write_vault_to_graph(
                    graph_store,
                    meta,
                    page_bodies,
                    acquired=acquired,
                    provenance=provenance,
                    compiled_slugs=compiled_slugs,
                    normalized=normalized,
                    scope=scope,
                )
                yield WikiPipelineEvent(
                    kind=WikiEventKind.STAGE_PROGRESS,
                    phase=WikiPhase.PERSISTING,
                    message=f"Mirrored vault to graph — {stats['nodes_written']} nodes, {stats['rels_written']} rels",
                    detail={**stats},
                )
            except Exception as e:  # noqa: BLE001
                yield WikiPipelineEvent(
                    kind=WikiEventKind.STAGE_PROGRESS,
                    phase=WikiPhase.PERSISTING,
                    message=(
                        f"⚠ Graph write failed: {type(e).__name__}: {e} — "
                        "disk vault is valid; run `opentraceai vault attach "
                        f"{vault_name}` to retry"
                    ),
                    errors=[f"{type(e).__name__}: {e}"],
                )

        done_message = f"Compile complete — {len(acquired)} new source(s) indexed"
        done_detail: dict[str, Any] = {"new_sources": len(acquired)}
        # Billed-token actuals, as the provider reported them per call. Real
        # clients carry a UsageTally; injected test fakes may not (getattr),
        # and zero calls means nothing to report. Consumers print this next to
        # the pre-flight estimate so a stale estimate is contradicted by every
        # run instead of surviving until someone re-derives it by hand.
        tally = getattr(extraction_client, "usage", None)
        if tally is not None:
            usage = tally.as_dict()
            if usage["calls"]:
                done_detail["llm_usage"] = usage
        yield WikiPipelineEvent(
            kind=WikiEventKind.DONE,
            phase=WikiPhase.PERSISTING,
            message=done_message,
            detail=done_detail,
        )


def _read_all_page_bodies(meta: VaultMetadata, pages_path: Path) -> dict[str, str]:
    """Read every page body referenced by *meta* from disk into a slug→body map.

    Always empty for vaults compiled after concept-page synthesis was removed.
    Retained because a vault compiled BEFORE that removal still carries pages
    in ``.vault.json``, and a re-compile must keep mirroring them rather than
    dropping them from the graph.
    """
    bodies: dict[str, str] = {}
    for slug in meta.pages.keys():
        path = pages_path / f"{slug}.md"
        try:
            bodies[slug] = path.read_text()
        except OSError:
            # Page missing on disk despite metadata — record empty body so the
            # graph writer at least creates the node + skips LINKS_TO parsing.
            bodies[slug] = ""
    return bodies
