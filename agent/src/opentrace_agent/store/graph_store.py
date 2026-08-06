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

"""LadybugDB-backed graph store.

Same schema, same Cypher queries, interoperable databases.
"""

from __future__ import annotations

import json
import logging
from collections import deque
from typing import Any

import real_ladybug as ladybug

from opentrace_agent.gen.schema_gen import (
    NODE_TYPE_COMMUNITY,
    NODE_TYPE_INDEX_METADATA,
    REL_TYPE_MEMBER_OF_COMMUNITY,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def build_search_text(name: str, node_type: str, properties: dict[str, Any]) -> str:
    """Combine name, type, the node's gloss, and path into searchable text.

    The gloss lives under different property names across node types —
    ``summary`` and ``one_line_summary`` (KnowledgeDoc/Vault, code
    augmentations), ``description`` (legacy nodes written by other
    producers). We index all of them so every node is findable by its
    content, not just its name: without this, a topic query only matches the
    name token and a document whose filename says nothing about its subject
    never surfaces against code symbols that match by exact name. Duplicates
    across keys are harmless — FTS dedupes term frequency's effect via BM25
    saturation.
    """
    parts = [name, node_type]
    for key in ("summary", "one_line_summary", "description"):
        if val := properties.get(key):
            parts.append(str(val))
    if path := properties.get("path"):
        parts.append(str(path))
    return " ".join(parts)


def matches_filters(properties: dict[str, Any], filters: dict[str, Any]) -> bool:
    """Check if a node's properties match all filter conditions.

    Filter values containing ``*`` are treated as wildcard patterns
    (``*foo*`` substring, ``foo*`` prefix, ``*foo`` suffix). All other
    values match by ``str()`` equality.
    """
    import re

    for k, v in filters.items():
        prop = properties.get(k)
        if prop is None:
            return False
        v_str = str(v)
        if "*" in v_str:
            # Convert wildcard to regex: escape, then unescape stars to .*
            pattern = "^" + re.escape(v_str).replace(r"\*", ".*") + "$"
            if not re.match(pattern, str(prop)):
                return False
        elif str(prop) != v_str:
            return False
    return True


def _marshal_props(properties: dict[str, Any] | None) -> str:
    if not properties:
        return "{}"
    return json.dumps(properties)


def _unmarshal_props(s: str) -> dict[str, Any] | None:
    if not s or s == "{}":
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # LadybugDB auto-converts JSON strings into its internal MAP literal
    # format on read: {key: value, key2: value2} (no quotes).
    # Parse this format back into a Python dict.
    return _parse_ladybug_map(s)


def _parse_ladybug_map(s: str) -> dict[str, Any] | None:
    """Parse LadybugDB's ``{key: value, key2: value2}`` map literal format."""
    s = s.strip()
    if not s.startswith("{") or not s.endswith("}"):
        return None
    inner = s[1:-1].strip()
    if not inner:
        return None
    result: dict[str, Any] = {}
    for pair in _split_top_level(inner):
        pair = pair.strip()
        if ": " not in pair:
            continue
        key, _, value = pair.partition(": ")
        result[key.strip()] = _coerce_value(value.strip())
    return result or None


def _split_top_level(s: str) -> list[str]:
    """Split on commas that are not inside braces or brackets."""
    parts: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(s):
        if ch in ("{", "[", "("):
            depth += 1
        elif ch in ("}", "]", ")"):
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(s[start:i])
            start = i + 1
    parts.append(s[start:])
    return parts


def _coerce_value(v: str) -> Any:
    """Best-effort type coercion for LadybugDB map literal values."""
    if v == "True":
        return True
    if v == "False":
        return False
    if v == "None" or v == "null":
        return None
    try:
        return int(v)
    except ValueError:
        pass
    try:
        return float(v)
    except ValueError:
        pass
    return v


def _parse_props(raw: Any) -> dict[str, Any] | None:
    """Parse a properties value that may be a dict, dict-like, or a JSON string."""
    if isinstance(raw, dict):
        return raw or None
    # LadybugDB C++ bindings can return dict-like objects that aren't plain dicts.
    if hasattr(raw, "keys"):
        d = dict(raw)
        return d or None
    return _unmarshal_props(str(raw) if raw else "")


# ---------------------------------------------------------------------------
# GraphStore
# ---------------------------------------------------------------------------


class GraphStore:
    """Embedded graph store backed by LadybugDB.

    Schema::

        Node(id PK, type, name, properties, search_text)
        RELATES(FROM Node TO Node, id STRING, type STRING, properties STRING)
        FTS index ``node_fts`` on ``search_text`` with Porter stemmer
    """

    def __init__(self, db_path: str, *, read_only: bool = False) -> None:
        self.db_path = db_path
        self.read_only = read_only
        self._db = ladybug.Database(db_path, read_only=read_only)
        self._conn = ladybug.Connection(self._db)
        self._load_extensions()
        if not read_only:
            self._ensure_schema()

    # -- schema ----------------------------------------------------------

    def _load_extensions(self) -> None:
        """Install and load the FTS extension (required for full-text search)."""
        try:
            self._conn.execute("INSTALL FTS")
            self._conn.execute("LOAD EXTENSION FTS")
        except RuntimeError:
            pass  # already installed/loaded

    def _ensure_schema(self) -> None:
        stmts = [
            "CREATE NODE TABLE IF NOT EXISTS Node(id STRING PRIMARY KEY, type STRING, name STRING, properties STRING)",
            "CREATE REL TABLE IF NOT EXISTS RELATES(FROM Node TO Node, id STRING, type STRING, properties STRING)",
        ]
        for stmt in stmts:
            self._conn.execute(stmt)

        # Add search_text column (ALTER not idempotent — ignore if exists).
        try:
            self._conn.execute("ALTER TABLE Node ADD search_text STRING DEFAULT ''")
        except RuntimeError:
            pass  # column already exists

        # FTS index (also not idempotent).
        try:
            self._conn.execute("CALL CREATE_FTS_INDEX('Node', 'node_fts', ['search_text'], stemmer := 'porter')")
        except RuntimeError:
            pass  # index already exists

    # -- write -----------------------------------------------------------

    def add_node(
        self,
        id: str,
        node_type: str,
        name: str,
        properties: dict[str, Any] | None = None,
    ) -> None:
        """Insert or update a single node (MERGE)."""
        props_json = _marshal_props(properties)
        search_text = build_search_text(name, node_type, properties or {})
        self._conn.execute(
            "MERGE (n:Node {id: $id}) "
            "SET n.type = $type, n.name = $name, "
            "n.properties = $props, n.search_text = $search_text",
            parameters={
                "id": id,
                "type": node_type,
                "name": name,
                "props": props_json,
                "search_text": search_text,
            },
        )

    def add_relationship(
        self,
        id: str,
        rel_type: str,
        source_id: str,
        target_id: str,
        properties: dict[str, Any] | None = None,
    ) -> None:
        """Create a directed relationship between two existing nodes."""
        props_json = _marshal_props(properties)
        self._conn.execute(
            "MATCH (a:Node {id: $src}), (b:Node {id: $tgt}) "
            "CREATE (a)-[:RELATES {id: $id, type: $type, properties: $props}]->(b)",
            parameters={
                "src": source_id,
                "tgt": target_id,
                "id": id,
                "type": rel_type,
                "props": props_json,
            },
        )

    def merge_relationship(
        self,
        id: str,
        rel_type: str,
        source_id: str,
        target_id: str,
        properties: dict[str, Any] | None = None,
    ) -> None:
        """Create or update a relationship, matched by ID.

        Unlike :meth:`add_relationship`, this deletes any existing relationship
        with the same ``id`` before creating the new one, making it safe for
        idempotent imports.
        """
        # LadybugDB REL tables don't support MERGE, so delete-then-create.
        try:
            self._conn.execute(
                "MATCH (a:Node)-[r:RELATES {id: $id}]->(b:Node) DELETE r",
                parameters={"id": id},
            )
        except Exception:
            pass  # relationship didn't exist
        self.add_relationship(id, rel_type, source_id, target_id, properties)

    def delete_node(self, node_id: str) -> bool:
        """Delete a node and any edges touching it (DETACH DELETE).

        Returns ``True`` when a node existed and was removed, ``False`` when
        no such node was present.
        """
        if self.get_node(node_id) is None:
            return False
        # Detach incoming and outgoing edges first — LadybugDB DETACH DELETE
        # support varies, so we delete edges by RELATES match then the node.
        try:
            self._conn.execute(
                "MATCH (a:Node {id: $id})-[r:RELATES]->(:Node) DELETE r",
                parameters={"id": node_id},
            )
        except Exception:
            pass
        try:
            self._conn.execute(
                "MATCH (:Node)-[r:RELATES]->(b:Node {id: $id}) DELETE r",
                parameters={"id": node_id},
            )
        except Exception:
            pass
        self._conn.execute(
            "MATCH (n:Node {id: $id}) DELETE n",
            parameters={"id": node_id},
        )
        return True

    def import_batch(
        self,
        nodes: list[dict[str, Any]],
        relationships: list[dict[str, Any]],
    ) -> dict[str, int]:
        """Bulk import nodes then relationships.

        Accepts the same dict format used by the pipeline stages:
          - node: ``{id, type, name, properties}``
          - rel:  ``{id, type, source_id, target_id, properties}``

        Fast path: stream the batch through a temp CSV file and let
        LadybugDB's ``COPY FROM`` do a true bulk insert — much faster
        than per-row Cypher CREATE statements (Fix #16). Falls back
        to per-row MERGE for the batch on any failure (e.g. a primary
        key collision from a duplicate id within the batch).
        """
        if not nodes and not relationships:
            return {"nodes_created": 0, "relationships_created": 0, "errors": 0}

        try:
            return self._import_batch_via_copy(nodes, relationships)
        except Exception as exc:
            logger.warning(
                "Bulk COPY import failed (%s); falling back to per-row MERGE",
                exc,
                exc_info=False,
            )
            return self._import_batch_via_merge(nodes, relationships)

    def _import_batch_via_copy(
        self,
        nodes: list[dict[str, Any]],
        relationships: list[dict[str, Any]],
    ) -> dict[str, int]:
        """Fast-path: COPY FROM a temp CSV for both tables. Order matters:
        nodes first (so rel FROM/TO refs resolve), rels second.

        Pre-flight hygiene before each COPY (Fix #16). LadybugDB's
        COPY is strict and any of these would otherwise roll the
        whole batch back (and leave the underlying transaction in a
        state where subsequent ops can crash the process):

          * **In-batch dedup** — pipeline can emit the same node id
            twice within one batch.
          * **Cross-batch dedup** — query existing ids and drop them
            from this batch so we don't violate the PK constraint
            on rows that landed in a previous flush. Mirrors the
            MERGE upsert semantics for the typical "no-op on re-emit"
            case; updates to an existing node's name/properties are
            dropped, which matches the indexer's intent (it emits the
            same id with the same data).
          * **Rel FK filter** — drop rels whose FROM/TO nodes aren't
            yet in the DB. They'll come back on the next batch once
            their nodes have landed.
          * **PARALLEL=FALSE** — LadybugDB's parallel CSV reader can't
            handle quoted newlines (which our Python type-signature
            names regularly contain), so we force single-threaded
            reads. Any row that still trips up raises, which import_batch
            catches and routes to the MERGE fallback (no data loss).
        """
        import csv as _csv
        import os as _os
        import tempfile as _tempfile

        copy_opts = "(PARALLEL=FALSE)"
        nodes_ok = 0
        rels_ok = 0

        with _tempfile.TemporaryDirectory(prefix="opentrace-copy-") as tmpdir:
            if nodes:
                # In-batch dedup by id, keep last.
                seen: dict[str, dict[str, Any]] = {}
                for n in nodes:
                    seen[n["id"]] = n

                # Cross-batch dedup: drop ids already in the DB.
                candidate_ids = list(seen.keys())
                existing_node_ids: set[str] = set()
                if candidate_ids:
                    res = self._conn.execute(
                        "MATCH (n:Node) WHERE n.id IN $ids RETURN n.id",
                        parameters={"ids": candidate_ids},
                    )
                    while res.has_next():
                        existing_node_ids.add(str(res.get_next()[0]))

                deduped = [n for nid, n in seen.items() if nid not in existing_node_ids]

                if deduped:
                    csv_path = _os.path.join(tmpdir, "nodes.csv")
                    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
                        writer = _csv.writer(fh)
                        for n in deduped:
                            nid = n["id"]
                            ntype = n["type"]
                            nname = n["name"]
                            props = n.get("properties")
                            props_json = _marshal_props(props)
                            search_text = build_search_text(nname, ntype, props or {})
                            writer.writerow([nid, ntype, nname, props_json, search_text])
                    # Column order matches the schema declaration:
                    # id, type, name, properties, search_text.
                    self._conn.execute(f"COPY Node FROM '{csv_path}' {copy_opts}")
                nodes_ok = len(deduped)

            if relationships:
                # Pre-filter rels whose endpoints aren't in the DB.
                referenced: set[str] = set()
                for r in relationships:
                    referenced.add(r["source_id"])
                    referenced.add(r["target_id"])
                existing: set[str] = set()
                if referenced:
                    res = self._conn.execute(
                        "MATCH (n:Node) WHERE n.id IN $ids RETURN n.id",
                        parameters={"ids": list(referenced)},
                    )
                    while res.has_next():
                        existing.add(str(res.get_next()[0]))

                # In-batch dedup by id, keep last (matches node dedup above).
                rel_seen: dict[str, dict[str, Any]] = {}
                for r in relationships:
                    rel_seen[r["id"]] = r

                # Preserve merge-path idempotency: RELATES.id is not unique, so
                # COPY would append duplicate logical edges on re-import. Delete
                # any existing rels carrying these ids first, then re-insert.
                rel_ids = list(rel_seen.keys())
                if rel_ids:
                    self._conn.execute(
                        "MATCH ()-[r:RELATES]->() WHERE r.id IN $ids DELETE r",
                        parameters={"ids": rel_ids},
                    )

                clean_rels = [r for r in rel_seen.values() if r["source_id"] in existing and r["target_id"] in existing]
                if clean_rels:
                    csv_path = _os.path.join(tmpdir, "rels.csv")
                    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
                        writer = _csv.writer(fh)
                        for r in clean_rels:
                            writer.writerow(
                                [
                                    r["source_id"],
                                    r["target_id"],
                                    r["id"],
                                    r["type"],
                                    _marshal_props(r.get("properties")),
                                ]
                            )
                    # REL TABLE COPY columns: FROM_id, TO_id, then the rel
                    # column values in declaration order (id, type, properties).
                    self._conn.execute(f"COPY RELATES FROM '{csv_path}' {copy_opts}")
                rels_ok = len(clean_rels)

        return {
            "nodes_created": nodes_ok,
            "relationships_created": rels_ok,
            "errors": 0,
        }

    def _import_batch_via_merge(
        self,
        nodes: list[dict[str, Any]],
        relationships: list[dict[str, Any]],
    ) -> dict[str, int]:
        """Slow-path fallback used when COPY FROM raises. Mirrors the
        original per-row MERGE behaviour: each node and rel goes through
        a Cypher MERGE so re-runs are idempotent."""
        nodes_ok = 0
        rels_ok = 0
        errors = 0

        self._conn.execute("BEGIN TRANSACTION")
        try:
            for n in nodes:
                try:
                    self.add_node(
                        id=n["id"],
                        node_type=n["type"],
                        name=n["name"],
                        properties=n.get("properties"),
                    )
                    nodes_ok += 1
                except Exception:
                    logger.warning("Failed to import node %s", n.get("id"), exc_info=True)
                    errors += 1
            self._conn.execute("COMMIT")
        except Exception:
            logger.warning("Node transaction failed, rolling back", exc_info=True)
            try:
                self._conn.execute("ROLLBACK")
            except Exception:
                pass
            nodes_ok, errors = self._import_nodes_individually(nodes)

        self._conn.execute("BEGIN TRANSACTION")
        try:
            for r in relationships:
                try:
                    self.merge_relationship(
                        id=r["id"],
                        rel_type=r["type"],
                        source_id=r["source_id"],
                        target_id=r["target_id"],
                        properties=r.get("properties"),
                    )
                    rels_ok += 1
                except Exception:
                    logger.warning("Failed to import rel %s", r.get("id"), exc_info=True)
                    errors += 1
            self._conn.execute("COMMIT")
        except Exception:
            logger.warning("Rel transaction failed, rolling back", exc_info=True)
            try:
                self._conn.execute("ROLLBACK")
            except Exception:
                pass
            rels_count, rel_errors = self._import_rels_individually(relationships)
            rels_ok = rels_count
            errors += rel_errors

        return {
            "nodes_created": nodes_ok,
            "relationships_created": rels_ok,
            "errors": errors,
        }

    def _import_nodes_individually(self, nodes: list[dict[str, Any]]) -> tuple[int, int]:
        """Fallback: import nodes one at a time with auto-commit."""
        ok = 0
        errs = 0
        for n in nodes:
            try:
                self.add_node(
                    id=n["id"],
                    node_type=n["type"],
                    name=n["name"],
                    properties=n.get("properties"),
                )
                ok += 1
            except Exception:
                logger.warning("Failed to import node %s", n.get("id"), exc_info=True)
                errs += 1
        return ok, errs

    def _import_rels_individually(self, relationships: list[dict[str, Any]]) -> tuple[int, int]:
        """Fallback: import relationships one at a time with auto-commit."""
        ok = 0
        errs = 0
        for r in relationships:
            try:
                self.merge_relationship(
                    id=r["id"],
                    rel_type=r["type"],
                    source_id=r["source_id"],
                    target_id=r["target_id"],
                    properties=r.get("properties"),
                )
                ok += 1
            except Exception:
                logger.warning("Failed to import rel %s", r.get("id"), exc_info=True)
                errs += 1
        return ok, errs

    # -- fast relationship import (avoids the O(E^2) per-rel delete scan) -------
    #
    # ``merge_relationship`` deletes-then-creates by scanning the (unindexed)
    # ``RELATES.id`` for every edge — O(E) per rel, O(E^2) for a full save. The
    # pipeline's saving path instead learns which ids already exist *once*
    # (``existing_relationship_ids``), creates brand-new edges directly (no
    # scan), and batch-deletes only the ids it needs to replace
    # (``delete_relationships_by_ids``) before recreating them.

    _DELETE_CHUNK = 1000

    def existing_relationship_ids(self) -> set[str]:
        """Return the id of every relationship currently in the graph (one scan)."""
        result = self._conn.execute("MATCH ()-[r:RELATES]->() RETURN r.id")
        ids: set[str] = set()
        while result.has_next():
            ids.add(str(result.get_next()[0]))
        return ids

    def delete_relationships_by_ids(self, ids: list[str]) -> None:
        """Delete relationships whose id is in *ids*, in chunked ``IN`` queries.

        One full-relationship scan per chunk instead of one per id.
        """
        for start in range(0, len(ids), self._DELETE_CHUNK):
            chunk = ids[start : start + self._DELETE_CHUNK]
            self._conn.execute(
                "MATCH ()-[r:RELATES]->() WHERE r.id IN $ids DELETE r",
                parameters={"ids": chunk},
            )

    def create_relationships(self, relationships: list[dict[str, Any]]) -> dict[str, int]:
        """Bulk ``CREATE`` relationships in one transaction (no per-rel scan).

        Callers must guarantee the ids don't already exist in the DB (delete
        first if replacing) — this never deletes. Mirrors :meth:`import_batch`'s
        transaction + individual-fallback shape.

        De-dupes the input by id (last wins) before creating: the resolver can
        emit the same edge id from multiple call sites within one run (e.g. a
        variable derived from the same target via two paths), and a plain
        ``CREATE`` would otherwise produce parallel duplicate edges. This
        matches the old per-edge delete-then-create idempotency.
        """
        if not relationships:
            return {"relationships_created": 0, "errors": 0}
        relationships = list({r["id"]: r for r in relationships}.values())
        ok = 0
        errors = 0
        self._conn.execute("BEGIN TRANSACTION")
        try:
            for r in relationships:
                try:
                    self.add_relationship(
                        id=r["id"],
                        rel_type=r["type"],
                        source_id=r["source_id"],
                        target_id=r["target_id"],
                        properties=r.get("properties"),
                    )
                    ok += 1
                except Exception:
                    logger.warning("Failed to create rel %s", r.get("id"), exc_info=True)
                    errors += 1
            self._conn.execute("COMMIT")
        except Exception:
            logger.warning("Rel create transaction failed, rolling back", exc_info=True)
            try:
                self._conn.execute("ROLLBACK")
            except Exception:
                pass
            ok, errors = self._import_rels_individually(relationships)
        return {"relationships_created": ok, "errors": errors}

    # -- read ------------------------------------------------------------

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        """Fetch a single node by ID."""
        result = self._conn.execute(
            "MATCH (n:Node {id: $id}) RETURN n.id, n.type, n.name, n.properties",
            parameters={"id": node_id},
        )
        if not result.has_next():
            return None
        return _row_to_node(result.get_next())

    def list_nodes(
        self,
        node_type: str,
        filters: dict[str, Any] | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """List nodes of a given type, with optional property filters."""
        result = self._conn.execute(
            "MATCH (n:Node) WHERE n.type = $type RETURN n.id, n.type, n.name, n.properties",
            parameters={"type": node_type},
        )
        nodes: list[dict[str, Any]] = []
        while result.has_next() and len(nodes) < limit:
            n = _row_to_node(result.get_next())
            if filters and not matches_filters(n.get("properties") or {}, filters):
                continue
            nodes.append(n)
        return nodes

    def find_files_by_basename(
        self,
        basename: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Return File nodes whose ``properties.path`` ends in ``/<basename>``
        or equals ``<basename>`` (root-of-repo files).

        Suffix matching has no efficient predicate over the stored
        graph, so this method streams File nodes and filters in Python,
        stopping once *limit* matches accumulate.
        """
        suffix = "/" + basename
        result = self._conn.execute(
            "MATCH (n:Node) WHERE n.type = 'File' RETURN n.id, n.type, n.name, n.properties",
        )
        matches: list[dict[str, Any]] = []
        while result.has_next() and len(matches) < limit:
            n = _row_to_node(result.get_next())
            path = (n.get("properties") or {}).get("path") or ""
            if path == basename or path.endswith(suffix):
                matches.append(n)
        return matches

    def search_nodes(
        self,
        query: str,
        node_types: list[str] | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Search nodes by name (case-insensitive substring), with optional FTS.

        Tries FTS first, falls back to CONTAINS on name.
        """
        from opentrace_agent.store.constants import INTERNAL_NODE_TYPES

        # Try FTS first
        try:
            fts_results = self._fts_search(query, limit * 2)
            if fts_results:
                type_set = set(node_types) if node_types else None
                nodes: list[dict[str, Any]] = []
                for node_id, _score in fts_results:
                    n = self.get_node(node_id)
                    if n is None:
                        continue
                    if n["type"] in INTERNAL_NODE_TYPES:
                        continue
                    if type_set and n["type"] not in type_set:
                        continue
                    nodes.append(n)
                    if len(nodes) >= limit:
                        break
                return nodes
        except Exception:
            logger.debug("FTS search failed, using substring fallback", exc_info=True)

        # Substring fallback
        q = query.lower()
        result = self._conn.execute(
            "MATCH (n:Node) WHERE lower(n.name) CONTAINS $query AND n.type <> $meta "
            "RETURN n.id, n.type, n.name, n.properties",
            parameters={"query": q, "meta": self._METADATA_TYPE},
        )
        type_set = set(node_types) if node_types else None
        nodes = []
        while result.has_next() and len(nodes) < limit:
            n = _row_to_node(result.get_next())
            if type_set and n["type"] not in type_set:
                continue
            nodes.append(n)
        return nodes

    def search_graph(
        self,
        query: str,
        hops: int = 2,
        limit: int = 50,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Search nodes then expand their neighborhood via BFS.

        Returns (nodes, relationships).
        """
        hops = max(0, min(hops, 5))

        match_nodes = self.search_nodes(query, limit=limit)
        if not match_nodes:
            return [], []

        node_map: dict[str, dict[str, Any]] = {}
        rel_map: dict[str, dict[str, Any]] = {}

        for n in match_nodes:
            node_map[n["id"]] = n

        if hops > 0:
            for n in match_nodes:
                traversal = self.traverse(n["id"], direction="both", max_depth=hops)
                for t in traversal:
                    nid = t["node"]["id"]
                    if nid not in node_map:
                        node_map[nid] = t["node"]
                    rid = t["relationship"]["id"]
                    if rid not in rel_map:
                        rel_map[rid] = t["relationship"]
        else:
            # hops=0: return only relationships between matched nodes
            for r in self.list_relationships_for_nodes(set(node_map.keys()), limit * 2):
                rel_map[r["id"]] = r

        return list(node_map.values()), list(rel_map.values())

    # -- traversal -------------------------------------------------------

    def traverse(
        self,
        node_id: str,
        direction: str = "outgoing",
        max_depth: int = 3,
        relationship_type: str | None = None,
        relationship_types: list[str] | None = None,
        vault_scope: str | None = None,
        confidence_threshold: float | None = None,
    ) -> list[dict[str, Any]]:
        """BFS traversal from a starting node.

        Parameters
        ----------
        relationship_type
            Single rel-type filter (legacy single-string form).
        relationship_types
            Allowlist of rel types — when set, only these rel types traverse.
            Supersedes ``relationship_type`` if both are passed.
        vault_scope
            When set, only neighbours that belong to that vault are traversed.
            Membership follows ``CONTAINS`` edges — see :meth:`vault_member_ids`.
        confidence_threshold
            When > 0, relationships whose ``properties.confidence`` is below
            this value are skipped. Edges without a ``confidence`` property
            (or with a non-numeric one) are kept.

        Returns a list of ``{node, relationship, depth}`` dicts.
        """
        # Verify start node exists
        if self.get_node(node_id) is None:
            raise ValueError(f"node not found: {node_id}")

        rel_filter: set[str] | None
        if relationship_types:
            rel_filter = set(relationship_types)
        elif relationship_type:
            rel_filter = {relationship_type}
        else:
            rel_filter = None

        visited: set[str] = {node_id}
        results: list[dict[str, Any]] = []
        # Resolve vault membership ONCE (see vault_member_ids): a KnowledgeDoc
        # has no `vault` property, so filtering on one returned no documents.
        scope_ids = self.vault_member_ids(vault_scope) if vault_scope is not None else None

        queue: deque[tuple[str, int]] = deque([(node_id, 0)])

        while queue:
            curr_id, depth = queue.popleft()
            if depth >= max_depth:
                continue

            neighbors = self._get_neighbors(curr_id, direction)
            for nb_node, nb_rel in neighbors:
                if rel_filter is not None and nb_rel["type"] not in rel_filter:
                    continue
                if scope_ids is not None and nb_node["id"] not in scope_ids:
                    continue
                if confidence_threshold is not None and confidence_threshold > 0:
                    rel_props = nb_rel.get("properties") or {}
                    rel_conf = rel_props.get("confidence")
                    if rel_conf is not None:
                        try:
                            if float(rel_conf) < confidence_threshold:
                                continue
                        except (TypeError, ValueError):
                            pass
                if nb_node["id"] in visited:
                    continue
                visited.add(nb_node["id"])
                results.append(
                    {
                        "node": nb_node,
                        "relationship": nb_rel,
                        "depth": depth + 1,
                    }
                )
                queue.append((nb_node["id"], depth + 1))

        return results

    # -- stats -----------------------------------------------------------

    def get_stats(self) -> dict[str, Any]:
        """Return aggregate counts: total_nodes, total_edges, nodes_by_type."""
        result = self._conn.execute(
            "MATCH (n:Node) WHERE n.type <> $meta RETURN n.type, count(n)",
            parameters={"meta": self._METADATA_TYPE},
        )
        nodes_by_type: dict[str, int] = {}
        total_nodes = 0
        while result.has_next():
            row = result.get_next()
            ntype = str(row[0])
            count = int(row[1])
            nodes_by_type[ntype] = count
            total_nodes += count

        result = self._conn.execute("MATCH ()-[r:RELATES]->() RETURN count(r)")
        total_edges = 0
        if result.has_next():
            total_edges = int(result.get_next()[0])

        return {
            "total_nodes": total_nodes,
            "total_edges": total_edges,
            "nodes_by_type": nodes_by_type,
        }

    # -- knowledge graph (communities) ----------------------------------

    def save_community(
        self,
        id: str,
        name: str,
        community_id: int,
        cohesion: float,
        members: int,
        is_god: bool = False,
    ) -> None:
        """Upsert a Community node detected by Leiden/Louvain."""
        self.add_node(
            id=id,
            node_type=NODE_TYPE_COMMUNITY,
            name=name,
            properties={
                "community_id": community_id,
                "cohesion": cohesion,
                "members": members,
                "is_god": is_god,
            },
        )

    def save_membership(self, id: str, node_id: str, community_id: str) -> None:
        """Link a node to its Community via MEMBER_OF_COMMUNITY."""
        self.merge_relationship(
            id=id,
            rel_type=REL_TYPE_MEMBER_OF_COMMUNITY,
            source_id=node_id,
            target_id=community_id,
        )

    def iter_analysis_graph(
        self,
        *,
        exclude_types: tuple[str, ...] = (
            NODE_TYPE_COMMUNITY,
            NODE_TYPE_INDEX_METADATA,
        ),
        exclude_rel_types: tuple[str, ...] = (REL_TYPE_MEMBER_OF_COMMUNITY,),
    ) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
        """Return (nodes, edges) for analytical workloads (clustering, exports).

        Excludes Community/IndexMetadata nodes and the membership
        relationships that link them, so clustering operates on the underlying
        graph and doesn't ingest its own previous output.
        """
        node_result = self._conn.execute(
            "MATCH (n:Node) WHERE NOT n.type IN $excl RETURN n.id, n.type, n.name",
            parameters={"excl": list(exclude_types)},
        )
        nodes: list[dict[str, Any]] = []
        while node_result.has_next():
            r = node_result.get_next()
            nodes.append({"id": str(r[0]), "type": str(r[1]), "name": str(r[2])})

        edge_result = self._conn.execute(
            "MATCH (a:Node)-[r:RELATES]->(b:Node) "
            "WHERE NOT a.type IN $excl AND NOT b.type IN $excl AND NOT r.type IN $excl_rel "
            "RETURN a.id, b.id",
            parameters={"excl": list(exclude_types), "excl_rel": list(exclude_rel_types)},
        )
        edges: list[tuple[str, str]] = []
        while edge_result.has_next():
            r = edge_result.get_next()
            edges.append((str(r[0]), str(r[1])))
        return nodes, edges

    def clear_communities(self) -> None:
        """Remove all Community nodes and their membership edges.

        Used by ``opentraceai cluster`` to make re-clustering idempotent.
        """
        try:
            self._conn.execute(
                "MATCH (a:Node)-[r:RELATES]->(b:Node) WHERE r.type = $rt DELETE r",
                parameters={"rt": REL_TYPE_MEMBER_OF_COMMUNITY},
            )
        except Exception:
            logger.warning("clear_communities: failed to delete memberships", exc_info=True)
        try:
            self._conn.execute(
                "MATCH (n:Node) WHERE n.type = $t DETACH DELETE n",
                parameters={"t": NODE_TYPE_COMMUNITY},
            )
        except Exception:
            logger.warning("clear_communities: failed to delete communities", exc_info=True)

    def vault_member_ids(self, vault_name: str) -> set[str]:
        """Node ids belonging to *vault_name*: the vault node plus its members.

        Membership is the ``KnowledgeVault -CONTAINS-> KnowledgeDoc`` edge, NOT
        a per-node property. A ``KnowledgeDoc`` deliberately carries no
        ``vault`` property — it is content-addressed by sha and one document can
        belong to several vaults at once — so a property filter matches only the
        vault node itself and silently returns no documents. Every vault-scoped
        read must resolve membership through here.

        Returns an empty set when no such vault exists, which callers should
        treat as "scope matched nothing" rather than "scope not applied".
        """
        vault_id = f"vault::{vault_name}"
        if self.get_node(vault_id) is None:
            return set()
        ids = {vault_id}
        rows = self._conn.execute(
            "MATCH (v:Node)-[r:RELATES]->(d:Node) WHERE v.id = $vid AND r.type = 'CONTAINS' RETURN d.id",
            parameters={"vid": vault_id},
        )
        while rows.has_next():
            ids.add(str(rows.get_next()[0]))
        return ids

    def list_communities(self) -> list[dict[str, Any]]:
        """Return all Community nodes, ordered by community_id."""
        result = self._conn.execute(
            "MATCH (n:Node) WHERE n.type = $t RETURN n.id, n.name, n.properties",
            parameters={"t": NODE_TYPE_COMMUNITY},
        )
        rows: list[dict[str, Any]] = []
        while result.has_next():
            r = result.get_next()
            props = _parse_props(r[2]) or {}
            rows.append({"id": str(r[0]), "name": str(r[1]), **props})
        rows.sort(key=lambda x: x.get("community_id", 0))
        return rows

    def get_node_community(self, node_id: str) -> dict[str, Any] | None:
        """Return the Community a node belongs to, or None if unassigned."""
        result = self._conn.execute(
            "MATCH (n:Node {id: $id})-[r:RELATES]->(c:Node) "
            "WHERE r.type = $rt AND c.type = $ct "
            "RETURN c.id, c.name, c.properties LIMIT 1",
            parameters={
                "id": node_id,
                "rt": REL_TYPE_MEMBER_OF_COMMUNITY,
                "ct": NODE_TYPE_COMMUNITY,
            },
        )
        if not result.has_next():
            return None
        r = result.get_next()
        props = _parse_props(r[2]) or {}
        return {"id": str(r[0]), "name": str(r[1]), **props}

    def list_god_nodes(self, limit: int = 20, exclude_types: tuple[str, ...] = ()) -> list[dict[str, Any]]:
        """Return top-degree non-synthetic nodes.

        Degree = inbound + outbound RELATES count. Excludes the index-metadata
        type by default; pass extra types in ``exclude_types`` to filter further.
        """
        exclude = (NODE_TYPE_INDEX_METADATA, *exclude_types)
        result = self._conn.execute(
            "MATCH (n:Node) "
            "WHERE NOT n.type IN $excl "
            "OPTIONAL MATCH (n)-[r:RELATES]-() "
            "RETURN n.id, n.type, n.name, count(r) AS degree "
            "ORDER BY degree DESC LIMIT $lim",
            parameters={"excl": list(exclude), "lim": limit},
        )
        rows: list[dict[str, Any]] = []
        while result.has_next():
            r = result.get_next()
            rows.append(
                {
                    "id": str(r[0]),
                    "type": str(r[1]),
                    "name": str(r[2]),
                    "degree": int(r[3]),
                }
            )
        return rows

    def list_cross_community_bridges(self, limit: int = 50) -> list[dict[str, Any]]:
        """Return edges whose endpoints belong to different communities.

        Only returns edges where both endpoints have community membership; nodes
        with no community are silently skipped. Useful for surfacing cross-cluster
        couplings — places where two architecturally distinct regions touch.
        """
        result = self._conn.execute(
            "MATCH (a:Node)-[r:RELATES]->(b:Node), "
            "(a)-[ma:RELATES]->(ca:Node), (b)-[mb:RELATES]->(cb:Node) "
            "WHERE r.type <> $member_rel "
            "AND ma.type = $member_rel AND mb.type = $member_rel "
            "AND ca.type = $com AND cb.type = $com "
            "AND ca.id <> cb.id "
            "RETURN a.id, a.name, ca.id, ca.name, "
            "b.id, b.name, cb.id, cb.name, r.type LIMIT $lim",
            parameters={
                "member_rel": REL_TYPE_MEMBER_OF_COMMUNITY,
                "com": NODE_TYPE_COMMUNITY,
                "lim": limit,
            },
        )
        rows: list[dict[str, Any]] = []
        while result.has_next():
            r = result.get_next()
            rows.append(
                {
                    "source_id": str(r[0]),
                    "source_name": str(r[1]),
                    "source_community_id": str(r[2]),
                    "source_community_name": str(r[3]),
                    "target_id": str(r[4]),
                    "target_name": str(r[5]),
                    "target_community_id": str(r[6]),
                    "target_community_name": str(r[7]),
                    "relation": str(r[8]),
                }
            )
        return rows

    # -- metadata --------------------------------------------------------

    _METADATA_ID_PREFIX = "_meta:index:"
    _METADATA_TYPE = NODE_TYPE_INDEX_METADATA

    def save_metadata(self, metadata: dict[str, Any]) -> None:
        """Store index metadata for a repo (upserted on each index run).

        The node ID is ``_meta:index:{repoId}`` so each repo keeps its own
        metadata entry.
        """
        repo_id = metadata.get("repoId", "unknown")
        self.add_node(
            id=f"{self._METADATA_ID_PREFIX}{repo_id}",
            node_type=self._METADATA_TYPE,
            name="index",
            properties=metadata,
        )

    def get_metadata(self) -> list[dict[str, Any]]:
        """Return all stored index metadata entries (one per indexed repo)."""
        result = self._conn.execute(
            "MATCH (n:Node) WHERE n.type = $meta RETURN n.properties",
            parameters={"meta": self._METADATA_TYPE},
        )
        entries: list[dict[str, Any]] = []
        while result.has_next():
            raw = result.get_next()[0]
            if props := _parse_props(raw):
                entries.append(props)
        return entries

    # -- Repository discovery -------------------------------------------

    def list_repository_ids(self) -> list[str]:
        """Return every Repository node id, ordered by id."""
        result = self._conn.execute("MATCH (n:Node) WHERE n.type = 'Repository' RETURN n.id ORDER BY n.id")
        ids: list[str] = []
        while result.has_next():
            ids.append(str(result.get_next()[0]))
        return ids

    def repository_exists(self, repo_id: str) -> bool:
        """True if a Repository node with id *repo_id* is in the graph."""
        result = self._conn.execute(
            "MATCH (n:Node) WHERE n.type = 'Repository' AND n.id = $id RETURN 1 LIMIT 1",
            parameters={"id": repo_id},
        )
        return result.has_next()

    def list_repositories(self) -> list[dict[str, Any]]:
        """Return ``{id, name, properties}`` for every Repository node, ordered by id.

        ``properties`` is always a dict; an unparseable stored value
        is coerced to ``{}`` so callers can do ``.get(...)`` without
        type-checking first.
        """
        result = self._conn.execute(
            "MATCH (n:Node) WHERE n.type = 'Repository' RETURN n.id, n.name, n.properties ORDER BY n.id"
        )
        rows: list[dict[str, Any]] = []
        while result.has_next():
            row = result.get_next()
            rows.append(
                {
                    "id": str(row[0]),
                    "name": str(row[1]),
                    "properties": _parse_props(row[2]) or {},
                }
            )
        return rows

    # -- Repository deletion (used by reindex) --------------------------

    def delete_repo(self, repo_id: str) -> dict[str, int]:
        """Remove every node and relationship belonging to ``repo_id``.

        Used by server-mode reindex (Fix #6, Q6d): before a fresh index
        of an already-indexed repo, we must wipe the existing rows so
        the bulk-import path doesn't hit primary-key collisions.

        Scope: nodes whose id is exactly ``repo_id`` (the Repository
        node itself), nodes whose id starts with ``f"{repo_id}/"`` (every
        directory/file/symbol scoped to that repo), and the metadata
        row at ``_meta:index:{repo_id}``. Global nodes (e.g. shared
        Dependency entries) survive — they belong to no single repo.

        Returns ``{"nodes_deleted": N, "relationships_deleted": M}``.
        """
        prefix = f"{repo_id}/"
        meta_id = f"{self._METADATA_ID_PREFIX}{repo_id}"

        # Pre-count for a meaningful return value. LadybugDB lacks a
        # `RETURN count(*)` from DETACH DELETE, so we count up front.
        node_count = self._conn.execute(
            "MATCH (n:Node) WHERE n.id = $repo_id OR n.id STARTS WITH $prefix OR n.id = $meta_id RETURN count(n)",
            parameters={"repo_id": repo_id, "prefix": prefix, "meta_id": meta_id},
        )
        nodes_deleted = 0
        if node_count.has_next():
            nodes_deleted = int(node_count.get_next()[0])

        rel_count = self._conn.execute(
            "MATCH (a:Node)-[r]->(b:Node) "
            "WHERE a.id = $repo_id OR a.id STARTS WITH $prefix OR a.id = $meta_id "
            "   OR b.id = $repo_id OR b.id STARTS WITH $prefix OR b.id = $meta_id "
            "RETURN count(r)",
            parameters={"repo_id": repo_id, "prefix": prefix, "meta_id": meta_id},
        )
        rels_deleted = 0
        if rel_count.has_next():
            rels_deleted = int(rel_count.get_next()[0])

        # DETACH DELETE drops the node plus all incident relationships
        # in a single statement, so we don't need a separate edge delete.
        self._conn.execute(
            "MATCH (n:Node) WHERE n.id = $repo_id OR n.id STARTS WITH $prefix OR n.id = $meta_id DETACH DELETE n",
            parameters={"repo_id": repo_id, "prefix": prefix, "meta_id": meta_id},
        )

        return {"nodes_deleted": nodes_deleted, "relationships_deleted": rels_deleted}

    # -- lifecycle -------------------------------------------------------

    def close(self) -> None:
        """Release connection and database resources."""
        self._conn.close()
        self._db.close()

    def __enter__(self) -> GraphStore:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- private helpers -------------------------------------------------

    def _fts_search(self, query: str, limit: int) -> list[tuple[str, float]]:
        """Run FTS query and return ``(node_id, score)`` sorted best-first.

        ``top := $limit`` selects the top-N by relevance but does NOT
        guarantee the *row order* is sorted by score, so we sort here. This
        matters because every caller truncates the list to its own smaller
        limit: unsorted, a top-scoring node could be dropped in favour of a
        much weaker one that merely arrived earlier. (Observed: a query where
        the second-best hit, a KnowledgeDoc, came back last behind six hits
        scoring a third as high — invisible at any sane limit.)
        """
        result = self._conn.execute(
            "CALL QUERY_FTS_INDEX('Node', 'node_fts', $query, top := $limit) RETURN node.id, score",
            parameters={"query": query, "limit": limit},
        )
        results: list[tuple[str, float]] = []
        while result.has_next():
            row = result.get_next()
            results.append((str(row[0]), float(row[1])))
        results.sort(key=lambda r: r[1], reverse=True)
        return results

    def _get_neighbors(self, node_id: str, direction: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
        """Fetch immediate neighbors in the given direction.

        Returns list of (neighbor_node, relationship) tuples.
        """
        queries: list[str] = []
        if direction in ("outgoing", "both"):
            queries.append(
                "MATCH (a:Node {id: $id})-[r:RELATES]->(b:Node) "
                "RETURN r.id, r.type, r.properties, a.id AS src, b.id AS tgt, "
                "b.id AS nid, b.type AS ntype, b.name AS nname, b.properties AS nprops"
            )
        if direction in ("incoming", "both"):
            queries.append(
                "MATCH (a:Node {id: $id})<-[r:RELATES]-(b:Node) "
                "RETURN r.id, r.type, r.properties, b.id AS src, a.id AS tgt, "
                "b.id AS nid, b.type AS ntype, b.name AS nname, b.properties AS nprops"
            )

        pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for q in queries:
            result = self._conn.execute(q, parameters={"id": node_id})
            while result.has_next():
                vals = result.get_next()
                # [r.id, r.type, r.props, src, tgt, nid, ntype, nname, nprops]
                rel_props = _parse_props(vals[2])
                node_props = _parse_props(vals[8])
                rel = {
                    "id": str(vals[0]),
                    "type": str(vals[1]),
                    "properties": rel_props,
                    "source_id": str(vals[3]),
                    "target_id": str(vals[4]),
                }
                node = {
                    "id": str(vals[5]),
                    "type": str(vals[6]),
                    "name": str(vals[7]),
                    "properties": node_props,
                }
                pairs.append((node, rel))
        return pairs

    def list_relationships_for_nodes(
        self,
        node_ids: set[str],
        limit: int = 10000,
    ) -> list[dict[str, Any]]:
        """Return relationships where both endpoints are in *node_ids*."""
        if not node_ids:
            return []
        result = self._conn.execute(
            "MATCH (a:Node)-[r:RELATES]->(b:Node) "
            "WHERE a.id IN $ids AND b.id IN $ids "
            "RETURN r.id, r.type, r.properties, a.id, b.id "
            f"LIMIT {limit}",
            parameters={"ids": list(node_ids)},
        )
        rels: list[dict[str, Any]] = []
        while result.has_next():
            vals = result.get_next()
            props = _parse_props(vals[2])
            rels.append(
                {
                    "id": str(vals[0]),
                    "type": str(vals[1]),
                    "properties": props,
                    "source_id": str(vals[3]),
                    "target_id": str(vals[4]),
                }
            )
        return rels


# ---------------------------------------------------------------------------
# Row parsing
# ---------------------------------------------------------------------------


def _row_to_node(row: list) -> dict[str, Any]:
    """Convert a result row [id, type, name, properties] to a node dict."""
    props = _parse_props(row[3])
    return {
        "id": str(row[0]),
        "type": str(row[1]),
        "name": str(row[2]),
        "properties": props,
    }
