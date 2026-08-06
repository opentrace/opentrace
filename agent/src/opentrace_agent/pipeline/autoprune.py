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

Deletion is the whole sweep. A document is stored verbatim and nothing is
derived from it, so it cannot go stale relative to a source — don't add a
``stale_since`` stamp here.
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

    documents_deleted: int = 0
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
    vault_name: str,
    db_path: str | None,
) -> AutopruneReport:
    """Delete graph state for docs absent from this walk.

    ``walked_doc_shas`` — sha256 of raw bytes for every doc surfaced this run.
    ``vault_name`` — required, and the only scope. Deletion follows the
        vault's ``CONTAINS`` edges, so a partial index can never reach
        another vault's documents. There is deliberately no unscoped mode:
        the fallback it would need is "every KnowledgeDoc in the graph".
    """
    report = AutopruneReport()

    # --- 1. Identify candidate documents in this vault ---
    candidate_docs = _docs_in_vault(store, vault_name=vault_name)

    walked_doc_ids = {f"corpus::{sha}" for sha in walked_doc_shas}

    orphan_docs = [d for d in candidate_docs if d["id"] not in walked_doc_ids]

    if not orphan_docs:
        return report  # nothing to do

    # --- 2. Delete corpus bodies for orphan documents ---
    if db_path:
        corpus_root = Path(db_path).resolve().parent / "corpus"
        for doc in orphan_docs:
            props = doc.get("properties") or {}
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

    # --- 3. Delete each orphan KnowledgeDoc + its edges ---
    for doc in orphan_docs:
        report.documents_deleted += 1
        _delete_node_and_edges(store, doc["id"])

    return report


# ---------------------------------------------------------------------------
# GraphStore queries — kept local so the autoprune module owns its own
# Cypher and the GraphStore API stays focused on reads.
# ---------------------------------------------------------------------------


def _docs_in_vault(store, *, vault_name: str) -> list[dict[str, Any]]:
    """Return the KnowledgeDocs that are candidates for orphan checking.

    KnowledgeDocs deliberately don't carry a ``vault`` property (they are
    content-addressed by sha and one document may live in several vaults at
    once — see ``wiki/ingest/graph_writer.py``). Vault membership is expressed
    via ``KnowledgeVault -CONTAINS-> KnowledgeDoc`` edges, so membership is
    resolved by traversing them. **Don't substitute a property filter here** —
    there is no per-doc vault property to filter on, so it would match nothing
    and the prune would silently become a no-op.
    """
    from opentrace_agent.wiki.ingest.graph_writer import vault_node_id

    results = store.traverse(
        vault_node_id(vault_name),
        direction="outgoing",
        max_depth=1,
        relationship_type="CONTAINS",
    )
    return [r["node"] for r in results if (r.get("node") or {}).get("type") == "KnowledgeDoc"]


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
