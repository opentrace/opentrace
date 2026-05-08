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

"""Write a vault's compile result into the graph store (OT-1732 Phase 4).

The disk-write path in :mod:`opentrace_agent.wiki.ingest.persist` is the
source of truth for the vault's filesystem state. This module mirrors the
*same* state into the graph as :class:`WikiVault`, :class:`WikiPage`, and
:class:`Source` nodes connected by ``CONTAINS``, ``CITES``, and
``LINKS_TO`` relationships.

Graph writes run *after* disk writes succeed, and any failure here is
caught and logged so the on-disk vault stays valid even if the graph
mirror falls behind. A ``backfill`` command (``opentraceai wiki backfill``)
exists to re-sync from disk when needed.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from opentrace_agent.store import GraphStore
from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.vault import VaultMetadata

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Node / edge type constants — kept in sync with proto/opentrace/v1/code_graph.proto
# ---------------------------------------------------------------------------

NODE_TYPE_WIKI_VAULT = "WikiVault"
NODE_TYPE_WIKI_PAGE = "WikiPage"
NODE_TYPE_SOURCE = "Source"

REL_TYPE_CONTAINS = "CONTAINS"
REL_TYPE_CITES = "CITES"
REL_TYPE_LINKS_TO = "LINKS_TO"

# ---------------------------------------------------------------------------
# ID conventions
# ---------------------------------------------------------------------------


def vault_node_id(vault_name: str) -> str:
    return f"vault::{vault_name}"


def page_node_id(vault_name: str, slug: str) -> str:
    return f"{vault_name}::{slug}"


def source_node_id(sha256: str) -> str:
    return f"source::{sha256}"


# ---------------------------------------------------------------------------
# Wiki-link parser
# ---------------------------------------------------------------------------

# Matches [[Page Title]] or [[Page Title|displayed text]]. Captures the
# target (everything before the optional `|`).
_WIKI_LINK_RE = re.compile(r"\[\[([^\[\]|]+?)(?:\|[^\[\]]+?)?\]\]")


def parse_wiki_links(body: str) -> list[str]:
    """Extract verbatim link targets from ``[[Title]]`` / ``[[Title|alias]]``.

    Returns titles in document order, deduplicated. Whitespace is stripped
    from each target so ``[[ Foo ]]`` matches ``Foo``.
    """
    seen: set[str] = set()
    out: list[str] = []
    for m in _WIKI_LINK_RE.finditer(body):
        target = m.group(1).strip()
        if not target or target in seen:
            continue
        seen.add(target)
        out.append(target)
    return out


# ---------------------------------------------------------------------------
# Graph writer
# ---------------------------------------------------------------------------


def delete_vault_from_graph(store: GraphStore, vault_name: str) -> dict[str, int]:
    """Remove a vault's WikiVault and WikiPage nodes, plus any Source nodes
    that no other vault still references via ``CONTAINS``. Symmetric
    counterpart of :func:`write_vault_to_graph`.

    Source nodes are shared across vaults by sha256 identity — deleting a
    vault must NOT delete a Source that another vault still uses. We resolve
    this by inspecting the incoming ``CONTAINS`` edges on each Source: if the
    only remaining edge originates from the vault being deleted (or none
    does), the Source is orphaned and can go too.

    Returns
    -------
    dict
        ``{"nodes_deleted": N}`` for telemetry / tests.
    """
    deleted = 0
    vault_id = vault_node_id(vault_name)

    # 1. Collect Source IDs reachable from this vault BEFORE we delete anything.
    sources_in_vault: list[str] = []
    try:
        contained = store.traverse(
            vault_id,
            direction="outgoing",
            max_depth=1,
            relationship_type=REL_TYPE_CONTAINS,
        )
    except ValueError:
        contained = []  # vault node already gone
    for r in contained:
        if r["node"]["type"] == NODE_TYPE_SOURCE:
            sources_in_vault.append(r["node"]["id"])

    # 2. Delete WikiPages belonging to this vault. Pages are 1:1 with their
    #    vault (id is "<vault>::<slug>") so the property check is sufficient.
    for n in store.list_nodes(node_type=NODE_TYPE_WIKI_PAGE, limit=100_000):
        props = n.get("properties") or {}
        if props.get("vault") != vault_name:
            continue
        if store.delete_node(n["id"]):
            deleted += 1

    # 3. Delete the WikiVault node itself.
    if store.delete_node(vault_id):
        deleted += 1

    # 4. Delete shared Source nodes only when no other vault still references
    #    them. We re-check after deleting the WikiVault above so the just-
    #    deleted vault's CONTAINS edges are gone from the count.
    for sid in sources_in_vault:
        try:
            inbound = store.traverse(
                sid,
                direction="incoming",
                max_depth=1,
                relationship_type=REL_TYPE_CONTAINS,
            )
        except ValueError:
            inbound = []
        # If any other WikiVault still CONTAINS this source, leave it alone.
        still_referenced = any(r["node"]["type"] == NODE_TYPE_WIKI_VAULT for r in inbound)
        if still_referenced:
            continue
        if store.delete_node(sid):
            deleted += 1

    logger.debug(
        "vault graph delete: removed %d nodes (vault=%s, sources_considered=%d)",
        deleted,
        vault_name,
        len(sources_in_vault),
    )
    return {"nodes_deleted": deleted}


def write_vault_to_graph(
    store: GraphStore,
    meta: VaultMetadata,
    page_bodies: dict[str, str],
    acquired: list[AcquiredSource] | None = None,
    provenance: dict[str, Any] | None = None,
    compiled_slugs: set[str] | None = None,
) -> dict[str, int]:
    """Mirror *meta* + *page_bodies* into the graph as a fresh consistent slice.

    Writes every page in ``meta.pages`` (not just the ones changed in this
    compile run) so the graph reflects the post-compile vault state in full.
    Edges are upserted via :meth:`GraphStore.merge_relationship` where
    available; otherwise fresh edges are added (LadybugDB has no
    transaction support, so duplicate-edge tolerance is left to query time).

    Parameters
    ----------
    store
        GraphStore handle; must be writeable.
    meta
        Loaded vault metadata (post-compile).
    page_bodies
        Map of slug → markdown body for each page in *meta.pages*. The caller
        supplies these because the in-memory ``CompiledPage`` is only
        available for pages written *this run*; older pages must be read
        from disk.
    acquired
        Sources acquired *this run*. Optional — the canonical source list
        comes from ``meta.sources``. Provided when the caller already has
        the AcquiredSource objects with content_type / size_bytes.
    provenance
        Provenance fields (``agent``, ``model``, ``session``, ``confidence``)
        to stamp on pages compiled this run. Pages not in *compiled_slugs*
        keep their existing provenance from a prior compile.
    compiled_slugs
        Slugs of pages produced or extended this run. When ``None`` (e.g.
        ``opentraceai wiki backfill``), no provenance is stamped — backfilled
        pages keep whatever provenance the graph already has.

    Returns
    -------
    dict
        ``{"nodes_written": N, "rels_written": M}`` for telemetry / tests.
    """
    nodes_written = 0
    rels_written = 0

    vault_id = vault_node_id(meta.name)

    # 1. Vault node. ``vault`` property is denormalised onto every
    #    vault-domain node so vault_scope filters in the retrieval layer
    #    can match by simple property equality.
    store.add_node(
        id=vault_id,
        node_type=NODE_TYPE_WIKI_VAULT,
        name=meta.name,
        properties={
            "vault": meta.name,
            "last_compiled_at": meta.last_compiled_at or "",
            "summary": "",
        },
    )
    nodes_written += 1

    # 2. Source nodes — one per ingested source. Use the AcquiredSource
    #    metadata when present, otherwise fall back to .vault.json's
    #    IngestedSource (sha256 + original_name + ingested_at only).
    by_sha_acquired: dict[str, AcquiredSource] = {s.sha256: s for s in (acquired or [])}
    for sha, ingested in meta.sources.items():
        sid = source_node_id(sha)
        acq = by_sha_acquired.get(sha)
        # Source nodes are shared across vaults by sha256 identity — vault
        # membership is expressed via the WikiVault -CONTAINS-> Source edge
        # (one edge per vault), NOT via a property on the Source itself. A
        # `vault` property would be wrong: the merge-on-write would overwrite
        # the previous tag whenever a second vault re-ingests the same file.
        props: dict[str, Any] = {
            "sha256": sha,
            "filename": ingested.original_name,
            "acquired_at": ingested.ingested_at,
        }
        if acq is not None:
            # AcquiredSource doesn't carry mime info; size comes from the
            # in-memory bytes (which we discard after compile per the
            # pointer-only provenance design).
            props["size_bytes"] = len(acq.data)
        store.add_node(
            id=sid,
            node_type=NODE_TYPE_SOURCE,
            name=ingested.original_name,
            properties=props,
        )
        nodes_written += 1
        # WikiVault CONTAINS Source.
        store.merge_relationship(
            id=f"{vault_id}->CONTAINS->{sid}",
            rel_type=REL_TYPE_CONTAINS,
            source_id=vault_id,
            target_id=sid,
        )
        rels_written += 1

    # 3. WikiPage nodes — one per slug. Maintain title→slug for LINKS_TO
    #    resolution.
    title_to_slug: dict[str, str] = {}
    sha_to_summary_slug: dict[str, str] = {}
    for slug, p in meta.pages.items():
        title_to_slug[p.title] = slug
        if p.kind == "source_summary" and p.source_shas:
            # Source-summary pages are 1:1 with a Source by construction.
            sha_to_summary_slug[p.source_shas[0]] = slug

    prov_keys = ("agent", "model", "session", "confidence")
    for slug, p in meta.pages.items():
        pid = page_node_id(meta.name, slug)
        page_props: dict[str, Any] = {
            "slug": p.slug,
            "vault": meta.name,
            "kind": p.kind,
            "one_line_summary": p.one_line_summary,
            "revision": p.revision,
            "last_updated": p.last_updated,
        }
        if provenance is not None and compiled_slugs is not None and slug in compiled_slugs:
            # Stamp provenance for pages produced or extended this run.
            for k in prov_keys:
                if k in provenance:
                    page_props[k] = provenance[k]
        else:
            # Preserve any existing provenance — `add_node` overwrites the
            # full property blob, so we read existing values forward.
            existing = store.get_node(pid)
            if existing and existing.get("properties"):
                for k in prov_keys:
                    if k in existing["properties"]:
                        page_props[k] = existing["properties"][k]
        store.add_node(
            id=pid,
            node_type=NODE_TYPE_WIKI_PAGE,
            name=p.title,
            properties=page_props,
        )
        nodes_written += 1
        # WikiVault CONTAINS WikiPage.
        store.merge_relationship(
            id=f"{vault_id}->CONTAINS->{pid}",
            rel_type=REL_TYPE_CONTAINS,
            source_id=vault_id,
            target_id=pid,
        )
        rels_written += 1

    # 4. CITES edges — provenance.
    #    source_summary WikiPage --CITES--> Source            (1:1 by sha)
    #    concept        WikiPage --CITES--> source_summary    (N from page.source_shas)
    for slug, p in meta.pages.items():
        pid = page_node_id(meta.name, slug)
        if p.kind == "source_summary":
            for sha in p.source_shas:
                sid = source_node_id(sha)
                store.merge_relationship(
                    id=f"{pid}->CITES->{sid}",
                    rel_type=REL_TYPE_CITES,
                    source_id=pid,
                    target_id=sid,
                )
                rels_written += 1
        else:  # "concept" or legacy "source" treated as concept
            for sha in p.source_shas:
                summary_slug = sha_to_summary_slug.get(sha)
                if not summary_slug:
                    continue
                target_pid = page_node_id(meta.name, summary_slug)
                store.merge_relationship(
                    id=f"{pid}->CITES->{target_pid}",
                    rel_type=REL_TYPE_CITES,
                    source_id=pid,
                    target_id=target_pid,
                )
                rels_written += 1

    # 5. LINKS_TO edges — parsed from [[Title]] occurrences in page bodies.
    for slug, body in page_bodies.items():
        if slug not in meta.pages:
            continue
        src_pid = page_node_id(meta.name, slug)
        for title in parse_wiki_links(body):
            target_slug = title_to_slug.get(title)
            if not target_slug or target_slug == slug:
                continue
            tgt_pid = page_node_id(meta.name, target_slug)
            store.merge_relationship(
                id=f"{src_pid}->LINKS_TO->{tgt_pid}",
                rel_type=REL_TYPE_LINKS_TO,
                source_id=src_pid,
                target_id=tgt_pid,
            )
            rels_written += 1

    logger.debug(
        "vault graph write complete: %d nodes, %d rels (vault=%s)",
        nodes_written,
        rels_written,
        meta.name,
    )
    return {"nodes_written": nodes_written, "rels_written": rels_written}
