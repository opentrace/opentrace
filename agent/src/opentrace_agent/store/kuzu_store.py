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

"""LadybugDB-backed graph store — Python equivalent of ``api/pkg/graph/kuzu.go``.

Same schema, same Cypher queries, interoperable databases.
"""

from __future__ import annotations

import json
import logging
from collections import deque
from typing import Any

import real_ladybug as kuzu

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers (mirrors Go helpers.go)
# ---------------------------------------------------------------------------


def build_search_text(name: str, node_type: str, properties: dict[str, Any]) -> str:
    """Combine name, type, summary, and path into searchable text."""
    parts = [name, node_type]
    if summary := properties.get("summary"):
        parts.append(str(summary))
    if path := properties.get("path"):
        parts.append(str(path))
    return " ".join(parts)


def matches_filters(properties: dict[str, Any], filters: dict[str, Any]) -> bool:
    """Check if a node's properties match all filter conditions."""
    for k, v in filters.items():
        prop = properties.get(k)
        if prop is None:
            return False
        if str(prop) != str(v):
            return False
    return True


def _marshal_props(properties: dict[str, Any] | None) -> str:
    if not properties:
        return "{}"
    return json.dumps(properties)


def _unmarshal_props(s: str) -> dict[str, Any] | None:
    if not s or s == "{}":
        return None
    return json.loads(s)


# ---------------------------------------------------------------------------
# KuzuStore
# ---------------------------------------------------------------------------


class KuzuStore:
    """Embedded graph store backed by LadybugDB.

    Schema matches the Go ``KuzuStore`` exactly::

        Node(id PK, type, name, properties, search_text)
        RELATES(FROM Node TO Node, id STRING, type STRING, properties STRING)
        FTS index ``node_fts`` on ``search_text`` with Porter stemmer
    """

    def __init__(self, db_path: str) -> None:
        self._db = kuzu.Database(db_path)
        self._conn = kuzu.Connection(self._db)
        self._ensure_schema()

    # -- schema ----------------------------------------------------------

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

    def import_batch(
        self,
        nodes: list[dict[str, Any]],
        relationships: list[dict[str, Any]],
    ) -> dict[str, int]:
        """Bulk import nodes then relationships inside explicit transactions.

        Accepts the same dict format used by the pipeline stages:
          - node: ``{id, type, name, properties}``
          - rel:  ``{id, type, source_id, target_id, properties}``

        Uses explicit BEGIN/COMMIT to avoid per-statement auto-commit overhead.
        Returns a summary dict.
        """
        nodes_ok = 0
        rels_ok = 0
        errors = 0

        # --- Nodes in a single transaction ---
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
            # Fall back to individual writes
            nodes_ok, errors = self._import_nodes_individually(nodes)

        # --- Relationships in a single transaction ---
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
            # Fall back to individual writes
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
                self.add_relationship(
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

    def search_nodes(
        self,
        query: str,
        node_types: list[str] | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Search nodes by name (case-insensitive substring), with optional FTS.

        Tries FTS first, falls back to CONTAINS on name.
        """
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
            "MATCH (n:Node) WHERE lower(n.name) CONTAINS $query RETURN n.id, n.type, n.name, n.properties",
            parameters={"query": q},
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
            all_rels = self._list_all_relationships(limit * 2)
            for r in all_rels:
                if r["source_id"] in node_map and r["target_id"] in node_map:
                    rel_map[r["id"]] = r

        return list(node_map.values()), list(rel_map.values())

    # -- traversal -------------------------------------------------------

    def traverse(
        self,
        node_id: str,
        direction: str = "outgoing",
        max_depth: int = 3,
        relationship_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """BFS traversal from a starting node.

        Returns a list of ``{node, relationship, depth}`` dicts.
        """
        # Verify start node exists
        if self.get_node(node_id) is None:
            raise ValueError(f"node not found: {node_id}")

        visited: set[str] = {node_id}
        results: list[dict[str, Any]] = []
        queue: deque[tuple[str, int]] = deque([(node_id, 0)])

        while queue:
            curr_id, depth = queue.popleft()
            if depth >= max_depth:
                continue

            neighbors = self._get_neighbors(curr_id, direction)
            for nb_node, nb_rel in neighbors:
                if relationship_type and nb_rel["type"] != relationship_type:
                    continue
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
        result = self._conn.execute("MATCH (n:Node) RETURN n.type, count(n)")
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

    # -- lifecycle -------------------------------------------------------

    def close(self) -> None:
        """Release connection and database resources."""
        self._conn.close()
        self._db.close()

    def __enter__(self) -> KuzuStore:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- private helpers -------------------------------------------------

    def _fts_search(self, query: str, limit: int) -> list[tuple[str, float]]:
        """Run FTS query and return list of (node_id, score)."""
        result = self._conn.execute(
            "CALL QUERY_FTS_INDEX('Node', 'node_fts', $query, top := $limit) RETURN node.id, score",
            parameters={"query": query, "limit": limit},
        )
        results: list[tuple[str, float]] = []
        while result.has_next():
            row = result.get_next()
            results.append((str(row[0]), float(row[1])))
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
                rel_props = _unmarshal_props(str(vals[2]) if vals[2] else "")
                node_props = _unmarshal_props(str(vals[8]) if vals[8] else "")
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

    def _list_all_relationships(self, limit: int) -> list[dict[str, Any]]:
        """List all relationships (used for hops=0 search_graph)."""
        result = self._conn.execute(
            f"MATCH (a:Node)-[r:RELATES]->(b:Node) RETURN r.id, r.type, r.properties, a.id, b.id LIMIT {limit}"
        )
        rels: list[dict[str, Any]] = []
        while result.has_next():
            vals = result.get_next()
            props = _unmarshal_props(str(vals[2]) if vals[2] else "")
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
    props = _unmarshal_props(str(row[3]) if row[3] else "")
    return {
        "id": str(row[0]),
        "type": str(row[1]),
        "name": str(row[2]),
        "properties": props,
    }
