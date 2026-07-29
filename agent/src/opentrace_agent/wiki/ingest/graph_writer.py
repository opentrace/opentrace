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
*same* state into the graph as :class:`Vault`, :class:`Page`, and
:class:`KnowledgeDoc` nodes connected by ``CONTAINS``, ``CITES`` (page →
KnowledgeDoc, direct by sha), ``LINKS_TO`` (page → page wiki-links),
``MENTIONS`` (page/KnowledgeDoc → entity), and ``MIRRORS`` (KnowledgeDoc → File
twin) relationships.

Graph writes run *after* disk writes succeed, and any failure here is
caught and logged so the on-disk vault stays valid even if the graph
mirror falls behind. A ``backfill`` command (``opentraceai wiki backfill``)
exists to re-sync from disk when needed.
"""

from __future__ import annotations

import logging
import mimetypes
import re
from typing import Any

from opentrace_agent.store import GraphStore
from opentrace_agent.wiki.ingest.sources import AcquiredSource
from opentrace_agent.wiki.slugify import kind_dir
from opentrace_agent.wiki.vault import VaultMetadata

logger = logging.getLogger(__name__)


def _sniff_content_type(filename: str) -> str:
    """Guess a MIME type from a filename. Returns "" when unknown."""
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or ""


# Confidence rubric (mirrors sources/markdown/prompts.py).
#
#   concept — LLM synthesis across sources. INFERRED, default 0.75
#             (median of {0.55, 0.65, 0.75, 0.85, 0.95}).
#
# This is a conservative default stamped at compile time without asking the
# LLM to self-rate. A future change can have the Execute prompt return a
# per-page tier so we pick up genuinely ambiguous output instead of always
# treating concepts as INFERRED.
_DEFAULT_CONFIDENCE_BY_KIND: dict[str, tuple[str, float]] = {
    "concept": ("INFERRED", 0.75),
}


def _confidence_for_kind(kind: str) -> tuple[str, float]:
    """Return ``(tier, score)`` for the given page kind. Falls back to INFERRED 0.75."""
    return _DEFAULT_CONFIDENCE_BY_KIND.get(kind, ("INFERRED", 0.75))


# ---------------------------------------------------------------------------
# Node / edge type constants — kept in sync with proto/opentrace/v1/code_graph.proto
# ---------------------------------------------------------------------------

NODE_TYPE_KNOWLEDGE_VAULT = "KnowledgeVault"
NODE_TYPE_KNOWLEDGE_CONCEPT = "KnowledgeConcept"
NODE_TYPE_KNOWLEDGE_DOC = "KnowledgeDoc"

REL_TYPE_CONTAINS = "CONTAINS"
REL_TYPE_CITES = "CITES"
REL_TYPE_LINKS_TO = "LINKS_TO"
REL_TYPE_MENTIONS = "MENTIONS"
REL_TYPE_MIRRORS = "MIRRORS"
REL_TYPE_DOCUMENTS = "DOCUMENTS"

# Code-tree types written by the DirectoryWalker; used here when a repo-walked
# doc needs a File twin the code walk didn't create (see _ensure_file_twin).
NODE_TYPE_FILE = "File"
NODE_TYPE_DIRECTORY = "Directory"
REL_TYPE_DEFINES = "DEFINES"

# Entity node types eligible as MENTIONS targets — flat entity types
# produced by ``--wiki``.
_MENTION_ENTITY_TYPES = frozenset({"Idea", "Service", "Module", "Paper", "Person", "Event"})

# ---------------------------------------------------------------------------
# ID conventions
# ---------------------------------------------------------------------------


def vault_node_id(vault_name: str) -> str:
    return f"vault::{vault_name}"


def page_node_id(vault_name: str, slug: str) -> str:
    return f"{vault_name}::{slug}"


def corpus_doc_node_id(sha256: str) -> str:
    return f"corpus::{sha256}"


def link_corpus_doc_mirrors(
    store: GraphStore,
    repo_id: str,
    named_blobs: list[tuple[str, bytes]],
) -> int:
    """Link KnowledgeDocs to the File nodes for the same repo-walked documents.

    *named_blobs* is ``[(repo_relative_path, raw_bytes), ...]`` for every doc
    the wiki pass ingested from a repo walk. For each, the KnowledgeDoc id is the
    sha256 of the raw bytes (same scheme as :func:`corpus_doc_node_id` /
    ``autoprune.compute_walked_shas``) and the File id is
    ``<repo_id>/<rel_path>``. A ``KnowledgeDoc -MIRRORS-> File`` edge is merged
    (idempotent) and the repo-relative ``path`` is stamped onto the KnowledgeDoc
    so the twins are mutually navigable. When the code walk didn't create the
    File node (extensions outside INCLUDED_EXTENSIONS — .rst/.txt/.html/PDFs),
    it is created here (see :func:`_ensure_file_twin`) so every repo-walked
    KnowledgeDoc has a File twin. Blobs that never became a KnowledgeDoc
    (content-gated) are skipped silently.

    Returns the number of MIRRORS edges written.
    """
    import hashlib

    edges = 0
    for rel_path, data in named_blobs:
        sha = hashlib.sha256(data).hexdigest()
        cid = corpus_doc_node_id(sha)
        fid = f"{repo_id}/{rel_path}"
        corpus_node = store.get_node(cid)
        if corpus_node is None:
            continue
        if store.get_node(fid) is None:
            _ensure_file_twin(store, repo_id, rel_path)
        store.merge_relationship(
            id=f"{cid}->MIRRORS->{fid}",
            rel_type=REL_TYPE_MIRRORS,
            source_id=cid,
            target_id=fid,
        )
        edges += 1
        props = dict(corpus_node.get("properties") or {})
        if props.get("path") != rel_path:
            props["path"] = rel_path
            store.add_node(
                id=cid,
                node_type=NODE_TYPE_KNOWLEDGE_DOC,
                name=corpus_node.get("name") or rel_path,
                properties=props,
            )
    return edges


def _ensure_file_twin(store: GraphStore, repo_id: str, rel_path: str) -> str:
    """Create the File node (and any missing ancestor Directory nodes) for a
    repo-walked doc the code walk didn't cover.

    Mirrors the DirectoryWalker's node shape exactly: ids are
    ``<repo_id>/<rel_path>``, each node hangs off its parent via ``DEFINES``,
    and File/Directory nodes carry a repo-relative ``path`` property. The
    walker already creates Directory nodes for every non-excluded dir, so the
    ancestor loop is a no-op in practice — it exists so a doc under a dir the
    code walk never persisted still gets a well-formed chain.
    """
    parts = rel_path.split("/")
    parent_id = repo_id
    for depth in range(1, len(parts)):
        rel_dir = "/".join(parts[:depth])
        dir_id = f"{repo_id}/{rel_dir}"
        if store.get_node(dir_id) is None:
            store.add_node(
                id=dir_id,
                node_type=NODE_TYPE_DIRECTORY,
                name=parts[depth - 1],
                properties={"path": rel_dir},
            )
            store.merge_relationship(
                id=f"{parent_id}->DEFINES->{dir_id}",
                rel_type=REL_TYPE_DEFINES,
                source_id=parent_id,
                target_id=dir_id,
            )
        parent_id = dir_id

    file_id = f"{repo_id}/{rel_path}"
    filename = parts[-1]
    _, dot, ext = filename.rpartition(".")
    props: dict[str, Any] = {"path": rel_path}
    if dot and ext:
        props["extension"] = f".{ext.lower()}"
    store.add_node(id=file_id, node_type=NODE_TYPE_FILE, name=filename, properties=props)
    store.merge_relationship(
        id=f"{parent_id}->DEFINES->{file_id}",
        rel_type=REL_TYPE_DEFINES,
        source_id=parent_id,
        target_id=file_id,
    )
    return file_id


def link_vault_to_repo(store: GraphStore, repo_id: str, vault_name: str) -> bool:
    """Link a repo-spawned vault to its Repository node.

    Merges ``Repository -DOCUMENTS-> Vault`` (idempotent) and stamps
    ``spawned_from=<repo_id>`` on the vault node so the provenance is
    self-describing. Called only from the ``index --wiki`` path where the
    wiki compile runs alongside a repo walk — vaults compiled from uploads
    or URLs and attached globals never reach this, so they never claim to
    document a repo they didn't come from. Returns True when the edge was
    written (both nodes present).
    """
    vid = vault_node_id(vault_name)
    vault_node = store.get_node(vid)
    if vault_node is None or store.get_node(repo_id) is None:
        return False
    store.merge_relationship(
        id=f"{repo_id}->DOCUMENTS->{vid}",
        rel_type=REL_TYPE_DOCUMENTS,
        source_id=repo_id,
        target_id=vid,
    )
    props = dict(vault_node.get("properties") or {})
    if props.get("spawned_from") != repo_id:
        props["spawned_from"] = repo_id
        store.add_node(
            id=vid,
            node_type=NODE_TYPE_KNOWLEDGE_VAULT,
            name=vault_node.get("name") or vault_name,
            properties=props,
        )
    return True


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
    """Remove a vault's Vault and Page nodes, plus any KnowledgeDoc nodes
    that no other vault still references via ``CONTAINS``. Symmetric
    counterpart of :func:`write_vault_to_graph`.

    KnowledgeDocs are shared across vaults by sha256 identity — deleting a
    vault must NOT delete a KnowledgeDoc that another vault still uses. We
    resolve this by inspecting the incoming ``CONTAINS`` edges on each: if
    the only remaining edge originates from the vault being deleted (or none
    does), the KnowledgeDoc is orphaned and can go too.

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
        if r["node"]["type"] == NODE_TYPE_KNOWLEDGE_DOC:
            sources_in_vault.append(r["node"]["id"])

    # 2. Delete Pages belonging to this vault. Pages are 1:1 with their
    #    vault (id is "<vault>::<slug>") so the property check is sufficient.
    for n in store.list_nodes(node_type=NODE_TYPE_KNOWLEDGE_CONCEPT, limit=100_000):
        props = n.get("properties") or {}
        if props.get("vault") != vault_name:
            continue
        if store.delete_node(n["id"]):
            deleted += 1

    # 3. Delete the Vault node itself.
    if store.delete_node(vault_id):
        deleted += 1

    # 4. Delete shared Source nodes only when no other vault still references
    #    them. We re-check after deleting the Vault above so the just-
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
        # If any other Vault still CONTAINS this source, leave it alone.
        still_referenced = any(r["node"]["type"] == NODE_TYPE_KNOWLEDGE_VAULT for r in inbound)
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
    normalized: list[Any] | None = None,
    scope: str = "global",
    derived_pairs: set[tuple[str, str]] | None = None,
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
    #    ``scope`` records whether this vault lives at the project-local
    #    or the user-global root.
    #    ``mirror_compiled_at`` stamps when *this* graph's mirror was
    #    written; ``vault list`` compares it against disk's
    #    ``last_compiled_at`` to flag stale mirrors when a global vault
    #    has been re-compiled from elsewhere.
    from datetime import datetime, timezone

    mirror_iso = datetime.now(timezone.utc).isoformat()
    vault_props: dict[str, Any] = {
        "vault": meta.name,
        "last_compiled_at": meta.last_compiled_at or "",
        "summary": "",
        "scope": scope,
        "mirror_compiled_at": mirror_iso,
    }
    # ``spawned_from`` is stamped by link_vault_to_repo AFTER the mirror on
    # ``index --wiki`` runs; carry it forward here so re-mirrors that don't
    # go through the linker (refresh-stale-pages, backfill) don't wipe it.
    existing_vault = store.get_node(vault_id)
    if existing_vault is not None:
        prev = (existing_vault.get("properties") or {}).get("spawned_from")
        if prev:
            vault_props["spawned_from"] = prev
    store.add_node(
        id=vault_id,
        node_type=NODE_TYPE_KNOWLEDGE_VAULT,
        name=meta.name,
        properties=vault_props,
    )
    nodes_written += 1

    # 2. KnowledgeDoc nodes — one per ingested document. Use the AcquiredSource
    #    metadata when present, otherwise fall back to .vault.json's
    #    IngestedSource (sha256 + original_name + ingested_at only).
    #    ``source_bodies`` collects each source's raw markdown along the way
    #    (in-memory for sources normalized this run, corpus file otherwise)
    #    for the MENTIONS pass in step 6.
    by_sha_acquired: dict[str, AcquiredSource] = {s.sha256: s for s in (acquired or [])}
    by_sha_normalized: dict[str, Any] = {n.sha256: n for n in (normalized or [])}
    source_bodies: dict[str, str] = {}
    for sha, ingested in meta.sources.items():
        sid = corpus_doc_node_id(sha)
        acq = by_sha_acquired.get(sha)
        norm = by_sha_normalized.get(sha)
        # KnowledgeDocs are shared across vaults by sha256 identity — vault
        # membership is expressed via the Vault -CONTAINS-> Source edge
        # (one edge per vault), NOT via a property on the Source itself. A
        # `vault` property would be wrong: the merge-on-write would overwrite
        # the previous tag whenever a second vault re-ingests the same file.
        props: dict[str, Any] = {
            "sha256": sha,
            "filename": ingested.original_name,
            "acquired_at": ingested.ingested_at,
        }
        if acq is not None:
            props["size_bytes"] = len(acq.data)
            props["content_type"] = _sniff_content_type(ingested.original_name)
        # ``norm`` is a NormalizedSource on a fresh compile, but attach /
        # promote / demote / re-mirror pass lightweight stubs that carry only
        # the fields they know (sha256 + corpus_path). Read every optional
        # field via getattr so a stub without ``title``/``markdown``/etc.
        # doesn't crash the mirror — the missing labels fall back to the
        # ``.vault.json`` IngestedSource below.
        norm_corpus_path = getattr(norm, "corpus_path", "") if norm is not None else ""
        if norm_corpus_path:
            # Body persisted on disk this run — point the node at it so
            # downstream consumers (``load_source``, concept synthesis)
            # can stream it back.
            props["corpus_path"] = norm_corpus_path
        # Navigation label: prefer this run's extraction (NormalizedSource),
        # fall back to the label persisted in .vault.json (covers ``vault
        # attach`` of a vault compiled elsewhere). Stored under BOTH keys:
        # ``one_line_summary`` matches the Page convention
        # (_neighbour_summary prefers it), and ``summary`` feeds
        # build_search_text so the label is FTS-findable.
        title = getattr(norm, "title", "") or getattr(ingested, "title", "")
        one_liner = getattr(norm, "one_line_summary", "") or getattr(ingested, "one_line_summary", "")
        if title:
            props["title"] = title
        if one_liner:
            props["one_line_summary"] = one_liner
            props["summary"] = one_liner
        # Epistemic status: this run's classification, else .vault.json's.
        status = getattr(norm, "status", "") or getattr(ingested, "status", "")
        if status:
            props["status"] = status
        # ``add_node`` overwrites the full property blob, and this loop runs
        # over ALL of meta.sources on every mirror — sources not (re)ingested
        # this run have no AcquiredSource/NormalizedSource, so carry their
        # previously-written values forward instead of wiping them.
        existing_src_props = (store.get_node(sid) or {}).get("properties") or {}
        for k in ("size_bytes", "content_type", "corpus_path", "title", "one_line_summary", "summary", "path", "status"):
            if k not in props and k in existing_src_props:
                props[k] = existing_src_props[k]
        store.add_node(
            id=sid,
            node_type=NODE_TYPE_KNOWLEDGE_DOC,
            name=ingested.original_name,
            properties=props,
        )
        nodes_written += 1
        # Vault CONTAINS KnowledgeDoc.
        store.merge_relationship(
            id=f"{vault_id}->CONTAINS->{sid}",
            rel_type=REL_TYPE_CONTAINS,
            source_id=vault_id,
            target_id=sid,
        )
        rels_written += 1
        norm_markdown = getattr(norm, "markdown", "") if norm is not None else ""
        if norm_markdown:
            source_bodies[sid] = norm_markdown
        else:
            body = _read_corpus_body(store, props.get("corpus_path"))
            if body:
                source_bodies[sid] = body

    # 3. Page nodes — one per slug. Maintain title→slug for LINKS_TO
    #    resolution. Slugs live under ``<kind_dir>/<base>``; we track both
    #    an unambiguous-by-title map and a fully-qualified
    #    ``<kind_dir>/<title>`` one. Ambiguous bare titles drop out so the
    #    LINKS_TO write surfaces broken links instead of silently picking
    #    the wrong target.
    title_to_slug: dict[str, str] = {}
    kinded_title_to_slug: dict[str, str] = {}
    ambiguous_titles: set[str] = set()
    for slug, p in meta.pages.items():
        kinded_title_to_slug[f"{kind_dir(p.kind)}/{p.title}"] = slug
        if p.title in title_to_slug:
            ambiguous_titles.add(p.title)
        else:
            title_to_slug[p.title] = slug

    prov_keys = ("agent", "model", "session", "confidence", "confidence_tier")
    # Graph-only fields not present on disk metadata. Carry forward on
    # every re-mirror so e.g. autoprune-stamped ``stale_since`` survives
    # a ``vault attach`` / promote / demote.
    graph_only_keys = ("stale_since",)
    for slug, p in meta.pages.items():
        pid = page_node_id(meta.name, slug)
        page_props: dict[str, Any] = {
            "slug": p.slug,
            "vault": meta.name,
            "kind": p.kind,
            # ``build_search_text`` indexes ``one_line_summary`` directly, so a
            # page is FTS-findable by its gloss, not just its title.
            "one_line_summary": p.one_line_summary,
            "revision": p.revision,
            "last_updated": p.last_updated,
        }
        existing = store.get_node(pid)
        existing_props = (existing or {}).get("properties") or {}
        for k in graph_only_keys:
            if k in existing_props:
                page_props[k] = existing_props[k]
        if provenance is not None and compiled_slugs is not None and slug in compiled_slugs:
            # Stamp provenance for pages produced or extended this run.
            # Concept pages default to INFERRED (0.75). Overridden by an
            # explicit confidence/confidence_tier in the provenance dict if
            # present (lets future per-page LLM self-ratings flow through).
            tier, score = _confidence_for_kind(p.kind)
            page_props["confidence"] = score
            page_props["confidence_tier"] = tier
            for k in prov_keys:
                if k in provenance:
                    page_props[k] = provenance[k]
        else:
            # Preserve any existing provenance — `add_node` overwrites the
            # full property blob, so we read existing values forward.
            for k in prov_keys:
                if k in existing_props:
                    page_props[k] = existing_props[k]
        store.add_node(
            id=pid,
            node_type=NODE_TYPE_KNOWLEDGE_CONCEPT,
            name=p.title,
            properties=page_props,
        )
        nodes_written += 1
        # Vault CONTAINS Page.
        store.merge_relationship(
            id=f"{vault_id}->CONTAINS->{pid}",
            rel_type=REL_TYPE_CONTAINS,
            source_id=vault_id,
            target_id=pid,
        )
        rels_written += 1

    # 4. CITES edges — provenance. Every page cites the Source nodes it was
    #    synthesised from, directly by sha (one hop, no intermediate page).
    for slug, p in meta.pages.items():
        pid = page_node_id(meta.name, slug)
        for sha in p.source_shas:
            sid = corpus_doc_node_id(sha)
            store.merge_relationship(
                id=f"{pid}->CITES->{sid}",
                rel_type=REL_TYPE_CITES,
                source_id=pid,
                target_id=sid,
            )
            rels_written += 1

    # 5. LINKS_TO edges — parsed from [[Title]] occurrences in page bodies.
    #    The link target may be bare (``[[Title]]``) or kinded
    #    (``[[concept/Title]]``). Kinded targets always win; bare targets
    #    only resolve when the title is unique across kinds.
    for slug, body in page_bodies.items():
        if slug not in meta.pages:
            continue
        src_pid = page_node_id(meta.name, slug)
        for target in parse_wiki_links(body):
            target_slug = kinded_title_to_slug.get(target)
            if target_slug is None and target not in ambiguous_titles:
                target_slug = title_to_slug.get(target)
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

    # 6. MENTIONS edges — bridge the entity layer to the content layer.
    #    For each entity (Idea/Service/Module/Paper/Person/Event) in this
    #    vault, find pages AND sources whose body contains the entity name
    #    as a whole word — matching over the raw source markdown gives docs
    #    the same per-document entity bridge that summary pages used to
    #    carry (with better coverage: the raw body is a superset of any
    #    summary). Case-insensitive except for Person (case-sensitive
    #    avoids matching "Karen" inside arbitrary lowercase prose).
    mention_bodies: dict[str, str] = {
        page_node_id(meta.name, slug): body for slug, body in page_bodies.items() if slug in meta.pages
    }
    mention_bodies.update(source_bodies)
    rels_written += _write_mentions_edges(store, meta, mention_bodies, derived_pairs=derived_pairs)

    logger.debug(
        "vault graph write complete: %d nodes, %d rels (vault=%s)",
        nodes_written,
        rels_written,
        meta.name,
    )
    return {"nodes_written": nodes_written, "rels_written": rels_written}


def _read_corpus_body(store: GraphStore, corpus_rel: str | None) -> str | None:
    """Read a source's corpus markdown given its DB-relative ``corpus_path``.

    Returns ``None`` when the path is unset, escapes the DB directory, or
    the file is unreadable — callers treat a missing body as "no MENTIONS
    pass for this source", never an error.
    """
    from pathlib import Path

    if not corpus_rel or ".." in corpus_rel or corpus_rel.startswith("/"):
        return None
    db_path = getattr(store, "db_path", None)
    if not db_path:
        return None
    try:
        return (Path(str(db_path)).parent / corpus_rel).read_text(encoding="utf-8")
    except OSError:
        return None


def _write_mentions_edges(
    store: GraphStore,
    meta: VaultMetadata,
    bodies_by_node_id: dict[str, str],
    derived_pairs: set[tuple[str, str]] | None = None,
) -> int:
    """Write MENTIONS edges from content nodes (Page / Source) to entity
    nodes whose names appear in the body.

    *bodies_by_node_id* maps a graph node id to the text to scan — page
    markdown for Pages, raw corpus markdown for Sources.

    *derived_pairs* is the set of ``(corpus_doc_id, entity_id)`` pairs the
    entity extraction produced a ``DERIVED_FROM`` edge for. A MENTIONS edge
    for such a pair is skipped — ``entity -DERIVED_FROM-> doc`` is the
    stronger claim ("extracted from") and already encodes that the doc is
    about the entity, so the reverse ``doc -MENTIONS-> entity`` would just
    restate it. Mentions of an entity by a doc it was NOT derived from (the
    genuine cross-reference) are still written. Consumers that want "every
    doc referencing X" union MENTIONS with incoming DERIVED_FROM.

    Only operates on entities tagged with this vault (so vault scope is
    preserved). Uses whole-word matching via ``\\b...\\b`` regex.

    Returns the number of edges written. No-op when no entities exist in
    the vault (the common case when ``--wiki`` wasn't used).
    """
    derived_pairs = derived_pairs or set()
    entities = _vault_entities(store, meta.name)
    if not entities:
        return 0

    # Build a regex matching any entity name, case-insensitive for non-Person.
    # Person names get their own pattern (case-sensitive) so "Karen" doesn't
    # match every casual mention.
    case_insensitive_entities = [e for e in entities if e["type"] != "Person"]
    case_sensitive_entities = [e for e in entities if e["type"] == "Person"]

    ci_pattern = _build_name_pattern([e["name"] for e in case_insensitive_entities], case_sensitive=False)
    cs_pattern = _build_name_pattern([e["name"] for e in case_sensitive_entities], case_sensitive=True)

    # Map lowercased / cased name → list of entity node ids (multiple
    # entities can share a name, especially across types — emit edges to
    # all matching).
    by_name_ci: dict[str, list[str]] = {}
    for e in case_insensitive_entities:
        by_name_ci.setdefault(e["name"].lower(), []).append(e["id"])
    by_name_cs: dict[str, list[str]] = {}
    for e in case_sensitive_entities:
        by_name_cs.setdefault(e["name"], []).append(e["id"])

    rels_written = 0
    for node_id, body in bodies_by_node_id.items():
        targets: set[str] = set()

        if ci_pattern is not None:
            for match in ci_pattern.finditer(body):
                for eid in by_name_ci.get(match.group(0).lower(), []):
                    targets.add(eid)
        if cs_pattern is not None:
            for match in cs_pattern.finditer(body):
                for eid in by_name_cs.get(match.group(0), []):
                    targets.add(eid)

        for eid in targets:
            # Skip when DERIVED_FROM already encodes this doc↔entity pair —
            # the reverse MENTIONS would be redundant.
            if (node_id, eid) in derived_pairs:
                continue
            store.merge_relationship(
                id=f"{node_id}->MENTIONS->{eid}",
                rel_type=REL_TYPE_MENTIONS,
                source_id=node_id,
                target_id=eid,
            )
            rels_written += 1

    return rels_written


def _vault_entities(store: GraphStore, vault_name: str) -> list[dict[str, Any]]:
    """Return entity-type nodes whose ``vault`` property matches *vault_name*."""
    out: list[dict[str, Any]] = []
    for ntype in _MENTION_ENTITY_TYPES:
        try:
            rows = store.list_nodes(ntype, filters={"vault": vault_name}, limit=10_000)
        except Exception:  # noqa: BLE001 — some types may not exist in this DB
            continue
        for r in rows:
            if r.get("name"):
                out.append({"id": r["id"], "type": ntype, "name": r["name"]})
    return out


def _build_name_pattern(names: list[str], *, case_sensitive: bool) -> "re.Pattern[str] | None":
    """Compile a whole-word-matching regex from a list of names.

    Names containing regex metacharacters are escaped. Longer names go
    first so the matcher prefers "Karen Chen" over "Karen" when both
    exist. Empty input returns ``None``.
    """
    if not names:
        return None
    sorted_names = sorted({n for n in names if n}, key=len, reverse=True)
    if not sorted_names:
        return None
    escaped = [re.escape(n) for n in sorted_names]
    pattern = r"\b(?:" + "|".join(escaped) + r")\b"
    flags = 0 if case_sensitive else re.IGNORECASE
    return re.compile(pattern, flags)
