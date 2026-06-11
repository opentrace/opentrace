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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from opentrace_agent.sources._llm_common import resolve_model
from opentrace_agent.wiki.ingest.entities import write_entities_to_graph
from opentrace_agent.wiki.ingest.execute import _wiki_concurrency
from opentrace_agent.wiki.ingest.execute import execute as _execute
from opentrace_agent.wiki.ingest.graph_writer import write_vault_to_graph
from opentrace_agent.wiki.ingest.normalize import normalize as _normalize
from opentrace_agent.wiki.ingest.persist import persist as _persist
from opentrace_agent.wiki.ingest.resolve import concepts_to_plan, resolve
from opentrace_agent.wiki.ingest.file_summaries import (
    summarise_sources as _summarise_sources,
)
from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.ingest.sources import acquire as _acquire
from opentrace_agent.wiki.ingest.types import (
    PAGE_KIND_FILE_SUMMARY,
    CompiledPage,
    ConceptMention,
    NormalizedSource,
    SourceInput,
    WikiEventKind,
    WikiPhase,
    WikiPipelineEvent,
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
    PageMeta,
    VaultMetadata,
    load_metadata,
    migrate_disk_layout,
    save_metadata,
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

        # Promote any legacy flat ``pages/<slug>.md`` files into the
        # folders-by-kind layout. Vaults compiled before the slug refactor
        # still have files at ``pages/usage.md``; after this step they live
        # at ``pages/concept/usage.md`` matching the (already-migrated)
        # metadata. No-op for fresh or already-migrated vaults.
        if migrate_disk_layout(meta, pages_path) > 0:
            save_metadata(meta_path, meta)

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
                phase=WikiPhase.SUMMARIZING_SOURCES,
                message=f"Skipped {before - len(normalized)} empty/low-content source(s) (< {min_chars} chars)",
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

        client: WikiLLM = llm or make_llm(provider, api_key=api_key, model=model, base_url=base_url)
        # File summaries are per-doc distillation — run them on the cheap tier
        # (role="wiki_summary", overridable via OT_WIKI_SUMMARY_MODEL) while plan
        # + synthesis keep the flagship `client`. When a caller injects `llm`
        # (tests), reuse it for both rather than spinning a second backend.
        summary_client: WikiLLM = llm or make_llm(
            provider,
            api_key=api_key,
            model=resolve_model(provider, None, role="wiki_summary"),
            base_url=base_url,
        )

        # One shared adaptive limiter across both clients (cheap summaries +
        # flagship resolve/synthesis). Starts at OT_WIKI_CONCURRENCY and ratchets
        # down on provider throttling so a high default stays safe on low API
        # tiers. Only wired for real backends — an injected `llm` (tests) gates
        # via the ThreadPoolExecutor alone.
        if llm is None:
            limiter = AdaptiveLimiter(_wiki_concurrency())
            client._limiter = limiter  # type: ignore[attr-defined]
            summary_client._limiter = limiter  # type: ignore[attr-defined]

        # File-summary pages — one per new source. Land in meta.pages
        # in-memory so Plan/Execute can treat them as neighbours and concept
        # pages can cite them via [[Title]] wiki-links (the neighbour list
        # marks each page's kind).
        file_summaries: list[CompiledPage] = []
        concept_mentions: list[ConceptMention] = []
        entity_nodes: list = []
        entity_rels: list = []
        yield from _summarise_sources(
            normalized,
            meta,
            summary_client,
            file_summaries,
            concept_mentions,
            entity_nodes,
            entity_rels,
        )
        # Merge the per-document entities into deduped nodes/edges (the same
        # merge the standalone entity-extraction stage used — keyed on
        # (type, canonical name)). These are mirrored into the graph below.
        if entity_nodes or entity_rels:
            from opentrace_agent.pipeline.entity_merge import merge_entities

            raw_entity_count = len(entity_nodes)
            entity_nodes, entity_rels, _ = merge_entities(entity_nodes, entity_rels)
            yield WikiPipelineEvent(
                kind=WikiEventKind.STAGE_PROGRESS,
                phase=WikiPhase.SUMMARIZING_SOURCES,
                message=(
                    f"Extracted {len(entity_nodes)} entities, {len(entity_rels)} relationships "
                    f"from {len(normalized)} doc(s) ({raw_entity_count} before merge)"
                ),
                detail={"entities": len(entity_nodes), "relationships": len(entity_rels)},
            )

        now_iso = datetime.now(timezone.utc).isoformat()
        for ss in file_summaries:
            meta.pages[ss.slug] = PageMeta(
                slug=ss.slug,
                title=ss.title,
                one_line_summary=ss.one_line_summary,
                source_shas=list(ss.source_shas),
                last_updated=now_iso,
                revision=ss.revision,
                kind=PAGE_KIND_FILE_SUMMARY,
            )

        # Resolve — cluster the per-document concept mentions (gathered during
        # summarisation) into concept pages. Each cluster unions every source
        # that mentioned the concept, so cross-document concepts surface even
        # when no single doc is "about" them. Runs on the flagship `client`
        # (semantic clustering is reasoning); diffed against the vault and
        # filtered by the min-sources floor into a create/extend plan.
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_START,
            phase=WikiPhase.PLANNING,
            message=f"Resolving concepts from {len(concept_mentions)} mention(s)",
            total=len(concept_mentions),
        )
        resolved = resolve(concept_mentions, client)
        plan_obj = concepts_to_plan(resolved, meta)
        yield WikiPipelineEvent(
            kind=WikiEventKind.STAGE_STOP,
            phase=WikiPhase.PLANNING,
            message=(
                f"Plan: {len(plan_obj.creates)} create, "
                f"{len(plan_obj.extends)} extend (from {len(resolved)} concept(s))"
            ),
            detail={
                "creates": len(plan_obj.creates),
                "extends": len(plan_obj.extends),
                "concepts": len(resolved),
            },
        )

        # Execute. Concept synthesis reads the RAW source bodies (the corpus
        # markdown carried on each NormalizedSource), not the digest summaries —
        # grounding each page in the full source yields more accurate synthesis
        # than re-distilling a lossy digest. See _sources_block.
        concept_pages: list[CompiledPage] = []
        if plan_obj.creates or plan_obj.extends:
            yield from _execute(plan_obj, normalized, meta, pages_path, client, concept_pages)

        compiled = file_summaries + concept_pages

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
                # Provenance: stamp agent/model/session on pages produced
                # this run. Pages not touched this run preserve whatever
                # provenance the graph already has. ``confidence`` /
                # ``confidence_tier`` are set per-page by graph_writer based
                # on page kind (file_summary → EXTRACTED, concept →
                # INFERRED) — see _confidence_for_kind there.
                provenance = {
                    "agent": "opentrace-wiki-compiler",
                    "model": model or _default_model_for(provider),
                    "session": str(uuid.uuid4()),
                }
                # Persist entity nodes/edges FIRST so the vault mirror's
                # MENTIONS pass (which scans for entity names in page bodies)
                # can see and link them.
                entities_written = write_entities_to_graph(graph_store, entity_nodes, entity_rels)
                compiled_slugs = {p.slug for p in compiled}
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
                    message=(
                        f"Mirrored vault to graph — {stats['nodes_written']} nodes, "
                        f"{stats['rels_written']} rels, {entities_written} entities"
                    ),
                    detail={**stats, "entities_written": entities_written},
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

        yield WikiPipelineEvent(
            kind=WikiEventKind.DONE,
            phase=WikiPhase.PERSISTING,
            message=(
                f"Compile complete — {len(file_summaries)} file summary "
                f"page(s), {len(concept_pages)} concept page(s)"
            ),
            detail={
                "file_summaries": len(file_summaries),
                "concept_pages": len(concept_pages),
                "new_sources": len(acquired),
            },
        )


def refresh_stale_pages(
    graph_store,
    *,
    vault_name: str | None = None,
    vault_root: Path | None = None,
    provider: str = PROVIDER_ANTHROPIC,
    api_key: str | None = None,
    model: str | None = None,
    base_url: str | None = None,
) -> int:
    """Re-run Plan+Execute against WikiPages with ``stale_since`` stamped.

    Used by both ``opentraceai vault refresh-stale-pages`` and the
    ``index --wiki --refresh-stale-pages`` flag, sharing the regeneration
    pass so both surfaces produce identical output.

    Returns the number of pages regenerated. Skips pages that have no
    remaining ``CITES`` edges (they should have been deleted by autoprune;
    we double-check as a safety net).
    """
    from opentrace_agent.wiki.ingest.execute import _execute_extend
    from opentrace_agent.wiki.ingest.types import PlanExtend

    # Find all stale WikiPage(kind="concept") nodes in scope.
    stale_pages = _find_stale_pages(graph_store, vault_name=vault_name)
    if not stale_pages:
        return 0

    client = make_llm(provider, api_key=api_key, model=model, base_url=base_url)
    regenerated = 0

    # A vault's scope (local|global) decides which on-disk root holds its
    # pages. We can't assume global — when the stale pages belong to a local
    # vault, paths must resolve under the project root (parent of the graph
    # DB's .opentrace/ dir).
    db_parent = Path(graph_store.db_path).resolve().parent.parent if getattr(graph_store, "db_path", None) else None

    for page in stale_pages:
        page_props = page.get("properties") or {}
        slug = page_props.get("slug")
        page_vault = page_props.get("vault")
        if not slug or not page_vault:
            continue

        # Remaining CITES — these are the still-live citations the page
        # should be regenerated against.
        remaining_source_shas = _remaining_source_shas_for_page(graph_store, page["id"])
        if not remaining_source_shas:
            continue  # autoprune should have deleted; skip defensively

        # Resolve scope from the WikiVault node, fall back to local since
        # that's the common case.
        from opentrace_agent.wiki.ingest.graph_writer import vault_node_id

        wv = graph_store.get_node(vault_node_id(page_vault))
        wv_scope = ((wv or {}).get("properties") or {}).get("scope", "local")
        path_kwargs: dict[str, Any] = {"scope": wv_scope}
        if wv_scope == "local" and db_parent is not None:
            path_kwargs["project_root"] = db_parent

        meta = load_metadata(metadata_path(page_vault, vault_root, **path_kwargs), name=page_vault)
        pages_path = pages_dir(page_vault, vault_root, **path_kwargs)
        normalized = _read_corpus_bodies_for_shas(graph_store, remaining_source_shas)

        item = PlanExtend(
            page_slug=slug,
            source_shas=remaining_source_shas,
            rationale="refresh-stale-pages: source removed",
        )

        try:
            compiled = _execute_extend(item, normalized, meta, pages_path, [], client)
        except Exception:  # noqa: BLE001
            logger.exception("refresh-stale-pages: failed to regenerate %s", page["id"])
            continue

        if compiled is None:
            continue

        # Write the new body to disk. Slug carries a ``<kind_dir>/`` prefix
        # so the parent folder may not exist yet on a fresh vault.
        page_path = pages_path / f"{compiled.slug}.md"
        page_path.parent.mkdir(parents=True, exist_ok=True)
        page_path.write_text(compiled.markdown_body)

        # Clear stale_since on success + bump revision.
        new_props = dict(page_props)
        new_props.pop("stale_since", None)
        new_props["revision"] = compiled.revision
        graph_store.add_node(
            id=page["id"],
            node_type=page["type"],
            name=page.get("name") or "",
            properties=new_props,
        )
        regenerated += 1

    return regenerated


def _find_stale_pages(graph_store, *, vault_name: str | None) -> list[dict]:
    """Return WikiPage nodes with stale_since stamped, scoped to *vault_name* when given."""
    pages = graph_store.list_nodes("WikiPage", limit=10_000)
    out = []
    for p in pages:
        props = p.get("properties") or {}
        if not props.get("stale_since"):
            continue
        if props.get("kind") != "concept":
            continue
        if vault_name and props.get("vault") != vault_name:
            continue
        out.append(p)
    return out


def _remaining_source_shas_for_page(graph_store, page_id: str) -> list[str]:
    """Walk outgoing CITES edges from a page to remaining Source shas.

    Concept pages CITE file_summary WikiPages, not Source nodes directly —
    the chain is ``concept -> file_summary -> Source``. Traverse two hops
    so we collect Sources both at depth 1 (direct citations, if any) and at
    depth 2 (via the file_summary hop). Dedup on sha.
    """
    traversal = graph_store.traverse(page_id, direction="outgoing", max_depth=2, relationship_type="CITES")
    shas: list[str] = []
    seen: set[str] = set()
    for r in traversal:
        node = r.get("node") or {}
        if node.get("type") != "Source":
            continue
        sha = (node.get("properties") or {}).get("sha256")
        if sha and sha not in seen:
            seen.add(sha)
            shas.append(sha)
    return shas


def _read_corpus_bodies_for_shas(graph_store, shas: list[str]):
    """Reconstruct NormalizedSource-like records for refresh-stale-pages Plan execution.

    The corpus already holds the bodies; we just need to wrap them so
    ``_emit_page_body`` can consume them.
    """
    from opentrace_agent.wiki.ingest.types import NormalizedSource

    out = []
    db_dir = Path(getattr(graph_store, "db_path", "")).parent if getattr(graph_store, "db_path", None) else None
    for sha in shas:
        source_node = graph_store.get_node(f"source::{sha}")
        if source_node is None or db_dir is None:
            continue
        props = source_node.get("properties") or {}
        corpus_rel = props.get("corpus_path")
        if not corpus_rel:
            continue
        body_path = db_dir / corpus_rel
        try:
            body = body_path.read_text(encoding="utf-8")
        except OSError:
            continue
        out.append(
            NormalizedSource(
                sha256=sha,
                original_name=props.get("filename") or sha,
                markdown=body,
            )
        )
    return out


def _default_model_for(provider: str) -> str:
    """Resolve the default model for *provider* via the shared BACKENDS registry.

    Used by the provenance record so it reflects the model that actually
    ran when the caller didn't pass one explicitly.
    """
    from opentrace_agent.sources._llm_common import resolve_model

    return resolve_model(provider, None)


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
