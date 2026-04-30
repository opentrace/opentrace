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
from collections.abc import Iterable, Iterator
from pathlib import Path

from datetime import datetime, timezone

from opentrace_agent.wiki.ingest.execute import execute as _execute
from opentrace_agent.wiki.ingest.normalize import normalize as _normalize
from opentrace_agent.wiki.ingest.persist import persist as _persist
from opentrace_agent.wiki.ingest.plan import plan as _plan
from opentrace_agent.wiki.ingest.source_summaries import (
    summarise_sources as _summarise_sources,
)
from opentrace_agent.wiki.ingest.sources import AcquiredSource, acquire as _acquire
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
from opentrace_agent.wiki.vault import PageMeta
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
from opentrace_agent.wiki.vault import load_metadata


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
    vault_root: Path | str | None = None,
    llm: WikiLLM | None = None,
) -> Iterator[WikiPipelineEvent]:
    """Compile uploaded files into the named vault.

    Yields :class:`WikiPipelineEvent` for each progress step. Source bytes are
    NOT retained on disk after this call returns. Per-vault concurrency is
    serialized via ``fcntl.flock``; a second concurrent call raises.

    ``provider`` selects the LLM backend (``"anthropic"`` or ``"gemini"``).
    ``llm`` is provided for tests; when set, ``provider``/``api_key``/``model``
    are ignored.
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

        client: WikiLLM = llm or make_llm(provider, api_key=api_key, model=model)

        # Source-summary pages — one per new source. Land in meta.pages
        # in-memory so Plan/Execute can treat them as neighbours and concept
        # pages can cite them via [[Source Summary: …]] wiki-links.
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
