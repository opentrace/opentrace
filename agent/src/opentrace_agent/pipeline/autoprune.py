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

"""Autoprune — sweep orphan KnowledgeDocs after a walk.

Runs after ``index --wiki`` / ``vault ingest`` to remove graph state for
documents that disappeared from disk between runs: the ``KnowledgeDoc`` node,
its edges, and its corpus body. Scoped to the walk's path and vault so partial
indexes don't blast away other repos' data. Zero LLM calls — the expensive
part stays explicit.

Two further sweeps ran here and are gone with the layers they served:

* Deleting LLM-extracted entities orphaned by a removed document — removed
  2026-08-04 with the entity layer.
* Deleting concept pages that lost their last ``CITES`` citation, and stamping
  ``stale_since`` on the ones that kept some — removed 2026-08-04 with the
  concept-page layer. Nothing synthesized pages, so nothing could go stale.

See the wiki CLAUDE.md for both, and the architecture doc
(``docs/architecture/ingestion-unification.md``) for the full design.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class AutopruneReport:
    """Counts surfaced after autoprune runs. Useful for the CLI summary."""

    sources_deleted: int = 0
    corpus_files_deleted: int = 0


def compute_walked_shas(walked_doc_paths: list[Path]) -> set[str]:
    """SHA-256 of raw file bytes for each walked doc path.

    Matches the scheme used by ``wiki/ingest/graph_writer.corpus_doc_node_id``
    so the resulting KnowledgeDoc ids align with what the doc-ingestion pass writes.
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
    vault_name: str | None,
    scope_path: Path | None,
    db_path: str | None,
) -> AutopruneReport:
    """Delete graph state for docs absent from this walk.

    ``walked_doc_shas`` — sha256 of raw bytes for every doc surfaced this run.
    ``vault_name`` — when set (``--wiki`` was used), scopes deletion
        to nodes carrying ``vault=<vault_name>``.
    ``scope_path`` — when set without ``vault_name``, scopes by source_uri
        prefix; otherwise deletion is vault-scoped.
    """
    report = AutopruneReport()

    # --- 1. Identify candidate Sources in scope ---
    candidate_sources = _sources_in_scope(store, vault_name=vault_name, scope_path=scope_path)

    walked_source_ids = {f"corpus::{sha}" for sha in walked_doc_shas}

    orphan_sources = [s for s in candidate_sources if s["id"] not in walked_source_ids]

    if not orphan_sources:
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

    # --- 3. Delete each orphan Source node + its edges ---
    for src in orphan_sources:
        report.sources_deleted += 1
        _delete_node_and_edges(store, src["id"])

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
    via ``Vault -CONTAINS-> Source`` edges, so we traverse from the
    Vault when ``vault_name`` is set.
    """
    if vault_name:
        from opentrace_agent.wiki.ingest.graph_writer import vault_node_id

        results = store.traverse(
            vault_node_id(vault_name),
            direction="outgoing",
            max_depth=1,
            relationship_type="CONTAINS",
        )
        return [r["node"] for r in results if (r.get("node") or {}).get("type") == "KnowledgeDoc"]
    candidates = store.list_nodes("KnowledgeDoc", limit=10_000)
    if scope_path is not None:
        prefix = str(scope_path.resolve())
        return [s for s in candidates if str((s.get("properties") or {}).get("source_uri") or "").startswith(prefix)]
    return candidates


# ---------------------------------------------------------------------------
# Mutations — wrap GraphStore's lower-level delete/update operations.
# ---------------------------------------------------------------------------


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
