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

from opentrace_agent.gen.schema_gen import NODE_TYPE_INDEX_METADATA

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def build_search_text(name: str, node_type: str, properties: dict[str, Any]) -> str:
    """Combine name, type, summary, path, and docs into searchable text.

    Docstrings (``docs``) are included so keyword search can hit nodes
    whose names are technical abbreviations but whose docstrings spell
    things out (``"authentication"``, ``"encrypt"``, ``"rate limit"``).
    Backwards compatible: the column is free-form text, so older
    indexes still work — they just carry less search content per row
    until re-indexed.
    """
    parts = [name, node_type]
    if summary := properties.get("summary"):
        parts.append(str(summary))
    if path := properties.get("path"):
        parts.append(str(path))
    if docs := properties.get("docs"):
        parts.append(str(docs))
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
        self._db = ladybug.Database(db_path, read_only=read_only)
        self._conn = ladybug.Connection(self._db)
        self._load_extensions()
        if not read_only:
            self._ensure_schema()

    # -- schema ----------------------------------------------------------

    def _load_extensions(self) -> None:
        """Install and load the FTS extension (required for full-text search).

        ``INSTALL`` and ``LOAD`` are kept in separate try blocks: in
        read-only mode ``INSTALL`` raises because it can't write the
        extension binary, but the extension may already be installed
        from a previous run — ``LOAD`` must still be attempted, otherwise
        every FTS query silently falls through to substring matching.

        When LOAD itself fails (e.g. LadybugDB's CDN doesn't ship the
        extension for the current version + platform), log a single
        warning so callers know they are degraded to substring search.
        """
        try:
            self._conn.execute("INSTALL FTS")
        except RuntimeError as e:
            logger.debug("INSTALL FTS skipped: %s", e)
        try:
            self._conn.execute("LOAD EXTENSION FTS")
            self._fts_loaded = True
        except RuntimeError as e:
            self._fts_loaded = False
            logger.warning(
                "FTS extension unavailable (%s) — keyword search will use "
                "substring matching against name + search_text. To enable "
                "full-text search, ensure the FTS extension is installed "
                "for this LadybugDB version + platform.",
                e,
            )

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
        """Create a directed relationship between two existing nodes.

        Raises ``RuntimeError`` if either endpoint isn't already in the
        DB.  This is critical: without the check, a MATCH that finds no
        rows would cause CREATE to silently do nothing, the caller
        would treat the call as successful, and the relationship would
        be lost without any error signal.  See
        ``GraphStoreAdapter._flush_rels`` for the upstream invariant
        that prevents this in the first place.
        """
        props_json = _marshal_props(properties)
        # Append RETURN so we can observe whether MATCH+CREATE yielded
        # any rows.  In Cypher, MATCH-then-CREATE only fires CREATE for
        # each row that MATCH produced — if MATCH finds nothing,
        # CREATE never runs, and RETURN comes back empty.
        result = self._conn.execute(
            "MATCH (a:Node {id: $src}), (b:Node {id: $tgt}) "
            "CREATE (a)-[r:RELATES {id: $id, type: $type, properties: $props}]->(b) "
            "RETURN r.id",
            parameters={
                "src": source_id,
                "tgt": target_id,
                "id": id,
                "type": rel_type,
                "props": props_json,
            },
        )
        if not result.has_next():
            raise RuntimeError(
                f"Relationship {id!r} (type={rel_type!r}) not created: "
                f"missing endpoint(s) — source={source_id!r}, target={target_id!r}. "
                f"This usually means the relationship was flushed before "
                f"its endpoint nodes were written. Check that "
                f"GraphStoreAdapter._flush_rels() flushes nodes first."
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

        # --- Relationships in a single transaction (idempotent via merge) ---
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

        # Substring fallback — match either the symbol name or its
        # ``search_text`` (which already includes summary/path/docs).
        # This keeps queries like "auth" useful when FTS is unavailable
        # (e.g. the Ladybug FTS extension binary isn't installed for the
        # current platform).
        q = query.lower()
        result = self._conn.execute(
            "MATCH (n:Node) "
            "WHERE (lower(n.name) CONTAINS $query "
            "       OR lower(n.search_text) CONTAINS $query) "
            "AND n.type <> $meta "
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
