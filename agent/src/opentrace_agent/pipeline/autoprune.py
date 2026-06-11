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

"""Autoprune — sweep orphan Sources / entities / pages after a walk.

Runs after ``index --wiki`` to remove graph state for files that disappeared
from disk between runs. Scoped to the walk's path and vault so partial indexes
don't blast away other repos' data.

Concept pages that lose a citation get ``stale_since`` stamped instead of
being regenerated — refresh is opt-in via ``opentraceai vault refresh-stale-pages``
or ``index --wiki --refresh-stale-pages`` (Phase 8). Zero LLM calls during
autoprune; the expensive part stays explicit.

See the architecture doc (``docs/architecture/ingestion-unification.md``)
for the full design.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class AutopruneReport:
    """Counts surfaced after autoprune runs. Useful for the CLI summary."""

    sources_deleted: int = 0
    entities_deleted: int = 0
    file_summary_pages_deleted: int = 0
    concept_pages_deleted: int = 0
    concept_pages_marked_stale: int = 0
    cites_edges_removed: int = 0
    corpus_files_deleted: int = 0


def compute_walked_shas(walked_doc_paths: list[Path]) -> set[str]:
    """SHA-256 of raw file bytes for each walked doc path.

    Matches the scheme used by ``wiki/ingest/graph_writer.source_node_id``
    so the resulting Source ids align with what the doc-ingestion pass writes.
    """
    shas: set[str] = set()
    for p in walked_doc_paths:
        try:
            shas.add(hashlib.sha256(p.read_bytes()).hexdigest())
        except OSError as exc:
            logger.warning("compute_walked_shas: skipped %s (%s)", p, exc)
    return shas


def autoprune_after_index(
    store,  # GraphStore — typed loosely to avoid the import cycle
    *,
    walked_doc_shas: set[str],
    walked_file_ids: set[str],
    vault_name: str | None,
    scope_path: Path | None,
    db_path: str | None,
) -> AutopruneReport:
    """Delete graph state for sources/entities/pages absent from this walk.

    ``walked_doc_shas`` — sha256 of raw bytes for every doc surfaced this run.
    ``walked_file_ids`` — File node ids surfaced for code this run.
    ``vault_name`` — when set (``--wiki`` was used), scopes deletion
        to nodes carrying ``vault=<vault_name>``.
    ``scope_path`` — when set without ``vault_name``, scopes by source_uri
        prefix; otherwise deletion is vault-scoped.
    """
    report = AutopruneReport()
    now_iso = datetime.now(timezone.utc).isoformat()

    # --- 1. Identify candidate Sources in scope ---
    candidate_sources = _sources_in_scope(store, vault_name=vault_name, scope_path=scope_path)

    walked_source_ids = {f"source::{sha}" for sha in walked_doc_shas}

    orphan_sources = [s for s in candidate_sources if s["id"] not in walked_source_ids]

    if not orphan_sources and not _has_orphan_code_entities(store, walked_file_ids):
        return report  # nothing to do

    # --- 2. Delete corpus bodies for orphan Sources ---
    if db_path:
        corpus_root = Path(db_path).resolve().parent / "corpus"
        for src in orphan_sources:
            props = src.get("properties") or {}
            rel = props.get("corpus_path")
            if rel:
                target = corpus_root.parent / rel
                try:
                    target.unlink()
                    report.corpus_files_deleted += 1
                except FileNotFoundError:
                    pass
                except OSError as exc:
                    logger.warning("autoprune: could not delete %s (%s)", target, exc)

    # --- 3. For each orphan Source: find dependent pages + entities ---
    # Track which concept pages we've already stamped this run so the
    # counter reflects unique-page-count, not edge-removal-count. A
    # concept page that cites multiple removed sources is still one
    # stale page, not N.
    already_marked_stale: set[str] = set()
    for src in orphan_sources:
        sid = src["id"]
        report.sources_deleted += 1

        # Find dependent file_summary pages (1:1 via CITES from page → source)
        # and concept pages (multi-source via CITES) that referenced this Source.
        # Scope to the target vault: Sources are content-addressed and may be
        # shared across vaults, so a page in *another* vault that happens to
        # cite the same Source must not be pruned by this vault's pass.
        page_ids_citing = _pages_in_vault(_pages_citing(store, sid), vault_name)

        # Find entities derived from this Source (DERIVED_FROM entity → source)
        derived_entities = _entities_derived_from(store, sid)

        # Delete the Source node + its edges.
        _delete_node_and_edges(store, sid)

        # Delete entities whose DERIVED_FROM edge to *sid* leaves them with no
        # remaining DERIVED_FROM target. (Multi-source entities — entities
        # cited from another live Source — stay.)
        for ent_id in derived_entities:
            if not _entity_still_has_derived_from(store, ent_id):
                _delete_node_and_edges(store, ent_id)
                report.entities_deleted += 1

        # For each page that cited this Source:
        for page in page_ids_citing:
            pid = page["id"]
            kind = (page.get("properties") or {}).get("kind") or "concept"

            # Remove the now-dangling CITES edge.
            removed = _delete_cites_edge(store, source_id=pid, target_id=sid)
            report.cites_edges_removed += removed

            if kind == "file_summary":
                # 1:1 with the deleted Source → page is meaningless. Delete it,
                # then cascade: concept pages CITE file_summary pages (not the
                # Source directly), so this deletion is the actual stale-trigger
                # for downstream concepts. Capture downstream citers before the
                # delete so the traversal sees the still-extant edges.
                downstream_pages = _pages_in_vault(_pages_citing(store, pid), vault_name)
                _delete_page_disk_file(store, page, vault_name=vault_name, db_path=db_path)
                _delete_node_and_edges(store, pid)
                report.file_summary_pages_deleted += 1

                for downstream in downstream_pages:
                    dpid = downstream["id"]
                    dkind = (downstream.get("properties") or {}).get("kind") or "concept"
                    if dkind == "file_summary":
                        # Unexpected — file_summary nesting isn't part of the
                        # schema. Skip rather than recurse.
                        continue
                    removed = _delete_cites_edge(store, source_id=dpid, target_id=pid)
                    report.cites_edges_removed += removed
                    remaining = _remaining_cites_count(store, dpid)
                    if remaining == 0:
                        _delete_page_disk_file(store, downstream, vault_name=vault_name, db_path=db_path)
                        _delete_node_and_edges(store, dpid)
                        report.concept_pages_deleted += 1
                    else:
                        _stamp_stale_since(store, dpid, now_iso)
                        if dpid not in already_marked_stale:
                            report.concept_pages_marked_stale += 1
                            already_marked_stale.add(dpid)
            else:
                remaining = _remaining_cites_count(store, pid)
                if remaining == 0:
                    _delete_page_disk_file(store, page, vault_name=vault_name, db_path=db_path)
                    _delete_node_and_edges(store, pid)
                    report.concept_pages_deleted += 1
                else:
                    _stamp_stale_since(store, pid, now_iso)
                    if pid not in already_marked_stale:
                        report.concept_pages_marked_stale += 1
                        already_marked_stale.add(pid)

    # --- 4. Code-side: prune entities whose File parent was removed ---
    #     File node pruning belongs to the structural pipeline itself
    #     (orphan files are removed by re-walks). We sweep their dependent
    #     entities here so the entity layer doesn't carry orphans.
    if walked_file_ids:
        report.entities_deleted += _prune_entities_for_missing_files(store, walked_file_ids, scope_path)

    return report


# ---------------------------------------------------------------------------
# GraphStore queries — kept local so the autoprune module owns its own
# Cypher and the GraphStore API stays focused on reads.
# ---------------------------------------------------------------------------


def _sources_in_scope(store, *, vault_name: str | None, scope_path: Path | None) -> list[dict[str, Any]]:
    """Return Source nodes that are candidates for orphan checking.

    Wiki-created Source nodes deliberately don't carry a ``vault`` property
    (sources are content-addressed by sha and may live in multiple vaults at
    once — see ``wiki/ingest/graph_writer.py``). Vault membership is expressed
    via ``WikiVault -CONTAINS-> Source`` edges, so we traverse from the
    WikiVault when ``vault_name`` is set.
    """
    if vault_name:
        from opentrace_agent.wiki.ingest.graph_writer import vault_node_id

        results = store.traverse(
            vault_node_id(vault_name),
            direction="outgoing",
            max_depth=1,
            relationship_type="CONTAINS",
        )
        return [r["node"] for r in results if (r.get("node") or {}).get("type") == "Source"]
    candidates = store.list_nodes("Source", limit=10_000)
    if scope_path is not None:
        prefix = str(scope_path.resolve())
        return [s for s in candidates if str((s.get("properties") or {}).get("source_uri") or "").startswith(prefix)]
    return candidates


def _pages_citing(store, source_id: str) -> list[dict[str, Any]]:
    """Return WikiPage nodes that have a CITES edge to *source_id*."""
    incoming = store.traverse(source_id, direction="incoming", max_depth=1, relationship_type="CITES")
    return [r["node"] for r in incoming if r.get("node", {}).get("type") == "WikiPage"]


def _pages_in_vault(pages: list[dict[str, Any]], vault_name: str | None) -> list[dict[str, Any]]:
    """Restrict *pages* to those tagged with *vault_name*; no-op when unset.

    Keeps a vault-scoped prune from deleting another vault's pages that cite a
    shared (content-addressed) Source.
    """
    if not vault_name:
        return pages
    return [p for p in pages if (p.get("properties") or {}).get("vault") == vault_name]


def _entities_derived_from(store, source_id: str) -> list[str]:
    """Return entity ids whose DERIVED_FROM points at *source_id*."""
    incoming = store.traverse(source_id, direction="incoming", max_depth=1, relationship_type="DERIVED_FROM")
    return [r["node"]["id"] for r in incoming if r.get("node")]


def _entity_still_has_derived_from(store, entity_id: str) -> bool:
    """True when an entity still has at least one DERIVED_FROM edge."""
    outgoing = store.traverse(entity_id, direction="outgoing", max_depth=1, relationship_type="DERIVED_FROM")
    return any(r.get("relationship", {}).get("type") == "DERIVED_FROM" for r in outgoing)


def _remaining_cites_count(store, page_id: str) -> int:
    outgoing = store.traverse(page_id, direction="outgoing", max_depth=1, relationship_type="CITES")
    return sum(1 for r in outgoing if r.get("relationship", {}).get("type") == "CITES")


def _has_orphan_code_entities(store, walked_file_ids: set[str]) -> bool:
    """Cheap check before the expensive entity walk — any code entity at all?"""
    # If walked_file_ids is empty, code wasn't part of this run; skip the sweep.
    return bool(walked_file_ids)


def _prune_entities_for_missing_files(store, walked_file_ids: set[str], scope_path: Path | None) -> int:
    """Delete entities derived from File nodes that aren't in *walked_file_ids*.

    Only operates when scope_path is set (entity_extraction was scoped to a
    walk path). Avoids global graph stomping.
    """
    if scope_path is None:
        return 0

    deleted = 0
    # Find File nodes that match the scope but aren't in walked_file_ids.
    files = store.list_nodes("File", limit=50_000)
    scope_prefix = str(scope_path.resolve())
    candidate_orphans = [
        f
        for f in files
        if (f.get("properties") or {}).get("path")
        and str(scope_prefix) in (f.get("properties") or {}).get("source_uri", "")
        and f["id"] not in walked_file_ids
    ]
    # We don't delete File nodes themselves — re-indexing handles that.
    # Just clean up their derived entities.
    for f in candidate_orphans:
        derived = _entities_derived_from(store, f["id"])
        for ent_id in derived:
            if not _entity_still_has_derived_from_anything_else(store, ent_id, f["id"]):
                _delete_node_and_edges(store, ent_id)
                deleted += 1
    return deleted


def _entity_still_has_derived_from_anything_else(store, entity_id: str, excluded_target: str) -> bool:
    outgoing = store.traverse(entity_id, direction="outgoing", max_depth=1, relationship_type="DERIVED_FROM")
    for r in outgoing:
        if r.get("relationship", {}).get("type") != "DERIVED_FROM":
            continue
        target = r.get("node", {}).get("id")
        if target and target != excluded_target:
            return True
    return False


# ---------------------------------------------------------------------------
# Mutations — wrap GraphStore's lower-level delete/update operations.
# ---------------------------------------------------------------------------


def _delete_page_disk_file(
    store,
    page: dict[str, Any],
    *,
    vault_name: str | None,
    db_path: str | None,
) -> None:
    """Best-effort delete the on-disk markdown for a WikiPage being pruned.

    The page's ``slug`` already encodes kind/base (e.g. ``file-summary/readme``),
    so the disk path is ``<vault>/pages/<slug>.md``. Resolves the vault dir
    using the WikiVault node's ``scope`` property; falls back to local scope
    when the WikiVault is missing.

    Failures (missing file, permission denied) are logged and swallowed —
    the graph node has already been removed, the disk file is a follow-up.
    """
    props = page.get("properties") or {}
    slug = props.get("slug")
    if not slug or not vault_name:
        return
    try:
        from opentrace_agent.wiki.ingest.graph_writer import vault_node_id
        from opentrace_agent.wiki.paths import pages_dir

        vault_node = store.get_node(vault_node_id(vault_name))
        scope = ((vault_node or {}).get("properties") or {}).get("scope", "local")
        project_root = Path(db_path).resolve().parent.parent if db_path and scope == "local" else None
        target = pages_dir(vault_name, scope=scope, project_root=project_root) / f"{slug}.md"
        target.unlink()
    except FileNotFoundError:
        pass
    except Exception as exc:  # noqa: BLE001 — best-effort; never fail prune over disk IO
        logger.warning("autoprune: could not delete page file for %s (%s)", page.get("id"), exc)


def _delete_node_and_edges(store, node_id: str) -> None:
    """Delete a node + all its incoming/outgoing edges.

    Delegates to ``GraphStore.delete_node`` which uses directional MATCH
    patterns (LadybugDB doesn't support undirected ``DELETE r`` over the
    typed REL table).
    """
    try:
        store.delete_node(node_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("autoprune: failed to delete %s (%s)", node_id, exc)


def _delete_cites_edge(store, *, source_id: str, target_id: str) -> int:
    try:
        store._conn.execute(
            "MATCH (a:Node {id: $sid})-[r:RELATES]->(b:Node {id: $tid}) WHERE r.type = 'CITES' DELETE r",
            parameters={"sid": source_id, "tid": target_id},
        )
        return 1
    except RuntimeError as exc:
        logger.warning(
            "autoprune: failed to delete CITES edge %s -> %s (%s)",
            source_id,
            target_id,
            exc,
        )
        return 0


def _stamp_stale_since(store, page_id: str, iso_ts: str) -> None:
    """Set ``stale_since=<iso_ts>`` on a WikiPage's properties blob.

    Reads-updates-writes via ``add_node`` (which upserts). Preserves all
    other properties.
    """
    existing = store.get_node(page_id)
    if existing is None:
        return
    props = dict(existing.get("properties") or {})
    props["stale_since"] = iso_ts
    store.add_node(
        id=page_id,
        node_type=existing["type"],
        name=existing.get("name") or "",
        properties=props,
    )
