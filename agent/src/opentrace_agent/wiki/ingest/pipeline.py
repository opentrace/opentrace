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
import uuid
from collections.abc import Iterable, Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from opentrace_agent.wiki.ingest.execute import execute as _execute
from opentrace_agent.wiki.ingest.graph_writer import write_vault_to_graph
from opentrace_agent.wiki.ingest.normalize import normalize as _normalize
from opentrace_agent.wiki.ingest.persist import persist as _persist
from opentrace_agent.wiki.ingest.plan import plan as _plan
from opentrace_agent.wiki.ingest.source_summaries import (
    summarise_sources as _summarise_sources,
)
from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.ingest.sources import acquire as _acquire
from opentrace_agent.wiki.ingest.types import (
    PAGE_KIND_SOURCE_SUMMARY,
    CompiledPage,
    NormalizedSource,
    Plan,
    SourceInput,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
)
from opentrace_agent.wiki.llm import (
    PROVIDER_ANTHROPIC,
    WikiLLM,
    make_llm,
)
from opentrace_agent.wiki.paths import (
    compile_log_dir,
    ensure_vault_layout,
    metadata_path,
    pages_dir,
)
from opentrace_agent.wiki.vault import PageMeta, VaultMetadata, load_metadata


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
    llm: WikiLLM | None = None,
    graph_store: Any = None,
) -> Iterator[WikiPipelineEvent]:
    """Compile uploaded files into the named vault.

    Yields :class:`WikiPipelineEvent` for each progress step. Source bytes are
    NOT retained on disk after this call returns. Per-vault concurrency is
    serialized via ``fcntl.flock``; a second concurrent call raises.

    ``provider`` selects the LLM backend (one of ``"anthropic"``, ``"gemini"``,
    ``"openai"``, ``"local"``). ``base_url`` is only used when ``provider``
    is ``"local"``. ``llm`` is provided for tests; when set,
    ``provider``/``api_key``/``model``/``base_url`` are ignored.

    When ``graph_store`` is supplied, the post-compile vault state is
    mirrored into the graph as a separate step *after* disk writes succeed.
    Failures during the graph write are caught and surfaced as a warning
    event so the on-disk vault stays valid even if the graph mirror falls
    behind. Re-sync from disk via ``opentraceai wiki backfill``.
    """
    ensure_vault_layout(vault_name, vault_root)
    meta_path = metadata_path(vault_name, vault_root)
    pages_path = pages_dir(vault_name, vault_root)
    log_path = compile_log_dir(vault_name, vault_root)

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

        if not normalized:
            yield WikiPipelineEvent(
                kind=WikiEventKind.DONE,
                phase=WikiPhase.NORMALIZING,
                message="All sources failed normalization — vault unchanged",
            )
            return

        client: WikiLLM = llm or make_llm(provider, api_key=api_key, model=model, base_url=base_url)

        # Source-summary pages — one per new source. Land in meta.pages
        # in-memory so Plan/Execute can treat them as neighbours and concept
        # pages can cite them via [[Title]] wiki-links (the neighbour list
        # marks each page's kind).
        source_summaries: list[CompiledPage] = []
        yield from _summarise_sources(normalized, meta, client, source_summaries)

        now_iso = datetime.now(timezone.utc).isoformat()
        for ss in source_summaries:
            meta.pages[ss.slug] = PageMeta(
                slug=ss.slug,
                title=ss.title,
                one_line_summary=ss.one_line_summary,
                source_shas=list(ss.source_shas),
                last_updated=now_iso,
                revision=ss.revision,
                kind=PAGE_KIND_SOURCE_SUMMARY,
            )

        # Plan — concept pages only. Source-summary pages are already in
        # meta.pages and feed the Plan prompt as cleaner-than-raw input.
        source_summaries_by_sha: dict[str, CompiledPage] = {
            ss.source_shas[0]: ss for ss in source_summaries if ss.source_shas
        }
        plans: list[Plan] = []
        yield from _plan(
            normalized,
            meta,
            client,
            plans,
            source_summaries_by_sha=source_summaries_by_sha,
        )
        plan_obj = plans[0] if plans else Plan()

        # Execute
        concept_pages: list[CompiledPage] = []
        if plan_obj.creates or plan_obj.extends:
            yield from _execute(plan_obj, normalized, meta, pages_path, client, concept_pages)

        compiled = source_summaries + concept_pages

        if not compiled:
            yield WikiPipelineEvent(
                kind=WikiEventKind.DONE,
                phase=WikiPhase.EXECUTING,
                message="No pages produced — vault unchanged",
            )
            return

        # Persist
        yield from _persist(compiled, acquired, meta, pages_path, meta_path, log_path)

        # Mirror the post-compile state into the graph if a store is given.
        # Disk-write has already succeeded, so failures here are non-fatal.
        if graph_store is not None:
            try:
                page_bodies = _read_all_page_bodies(meta, pages_path)
                # Provenance: stamp agent/model/session/confidence on pages
                # produced this run. Pages not touched this run preserve
                # whatever provenance the graph already has.
                provenance = {
                    "agent": "opentrace-wiki-compiler",
                    "model": model or _default_model_for(provider),
                    "session": str(uuid.uuid4()),
                    # 0.0 is the placeholder until real confidence
                    # computation lands. Documented in OT-1732 followups.
                    "confidence": 0.0,
                }
                compiled_slugs = {p.slug for p in compiled}
                stats = write_vault_to_graph(
                    graph_store,
                    meta,
                    page_bodies,
                    acquired=acquired,
                    provenance=provenance,
                    compiled_slugs=compiled_slugs,
                )
                yield WikiPipelineEvent(
                    kind=WikiEventKind.STAGE_PROGRESS,
                    phase=WikiPhase.PERSISTING,
                    message=(f"Mirrored vault to graph — {stats['nodes_written']} nodes, {stats['rels_written']} rels"),
                    detail=stats,
                )
            except Exception as e:  # noqa: BLE001
                yield WikiPipelineEvent(
                    kind=WikiEventKind.STAGE_PROGRESS,
                    phase=WikiPhase.PERSISTING,
                    message=(
                        f"⚠ Graph write failed: {type(e).__name__}: {e} — "
                        "disk vault is valid; run `opentraceai wiki backfill "
                        f"{vault_name}` to retry"
                    ),
                    errors=[f"{type(e).__name__}: {e}"],
                )

        yield WikiPipelineEvent(
            kind=WikiEventKind.DONE,
            phase=WikiPhase.PERSISTING,
            message=(
                f"Compile complete — {len(source_summaries)} source summary "
                f"page(s), {len(concept_pages)} concept page(s)"
            ),
            detail={
                "source_summaries": len(source_summaries),
                "concept_pages": len(concept_pages),
                "new_sources": len(acquired),
            },
        )


def _default_model_for(provider: str) -> str:
    """Mirror the per-provider defaults baked into the LLM clients so the
    provenance record reflects the model that actually ran when the caller
    didn't pass one explicitly. Kept in sync with ``wiki/llm.py``.
    """
    if provider == "gemini":
        return "gemini-2.5-flash"
    return "claude-sonnet-4-20250514"


def _read_all_page_bodies(meta: VaultMetadata, pages_path: Path) -> dict[str, str]:
    """Read every page body referenced by *meta* from disk into a slug→body map."""
    bodies: dict[str, str] = {}
    for slug in meta.pages.keys():
        path = pages_path / f"{slug}.md"
        try:
            bodies[slug] = path.read_text()
        except OSError:
            # Page missing on disk despite metadata — record empty body so
            # graph writer at least creates the node + skips LINKS_TO parsing.
            bodies[slug] = ""
    return bodies
