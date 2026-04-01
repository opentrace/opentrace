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

"""Export and import OpenTrace graphs as .parquet.zip archives.

The archive format matches the UI's export:
  - ``nodes_{Type}.parquet`` — one file per node type, columns: id, name, properties
  - ``relationships.parquet`` — columns: from, to, id, type, properties

This ensures files exported from the CLI can be imported in the UI and vice-versa.
"""

from __future__ import annotations

import io
import logging
import zipfile
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from opentrace_agent.store.graph_store import GraphStore, _marshal_props, _parse_props

logger = logging.getLogger(__name__)

_IMPORT_BATCH_SIZE = 10_000


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export_database(store: GraphStore) -> bytes:
    """Export the entire graph as a ``.parquet.zip`` archive.

    Returns the zip bytes ready to be written to a file.
    Writes parquet files directly into the zip to avoid double-buffering.
    """
    stats = store.get_stats()
    if stats["total_nodes"] == 0:
        raise ValueError("Nothing to export — the graph is empty.")

    all_node_ids: set[str] = set()
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Group nodes by type and write one parquet file per type
        for node_type, count in stats["nodes_by_type"].items():
            nodes = store.list_nodes(node_type, limit=count + 1000)
            if not nodes:
                continue

            rows = [
                {
                    "id": n["id"],
                    "name": n["name"],
                    "properties": _marshal_props(n.get("properties")),
                }
                for n in nodes
            ]
            all_node_ids.update(r["id"] for r in rows)
            table = pa.Table.from_pylist(rows)

            buf = io.BytesIO()
            pq.write_table(table, buf)
            zf.writestr(f"nodes_{node_type}.parquet", buf.getvalue())
            logger.debug("Exported %s: %d nodes", node_type, len(nodes))

        # Export relationships
        rels = store.list_relationships_for_nodes(all_node_ids)
        if rels:
            rel_rows = [
                {
                    "from": r["source_id"],
                    "to": r["target_id"],
                    "id": r["id"],
                    "type": r["type"],
                    "properties": _marshal_props(r.get("properties")),
                }
                for r in rels
            ]
            table = pa.Table.from_pylist(rel_rows)

            buf = io.BytesIO()
            pq.write_table(table, buf)
            zf.writestr("relationships.parquet", buf.getvalue())
            logger.debug("Exported %d relationships", len(rels))

    return zip_buf.getvalue()


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


def import_database(
    store: GraphStore,
    data: bytes,
    *,
    on_progress: Any | None = None,
) -> dict[str, int]:
    """Import a ``.parquet.zip`` archive into *store*.

    Returns ``{nodes_created, relationships_created, errors}``.
    """
    _progress(on_progress, "Unpacking Parquet archive")

    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise ValueError(
            f"Failed to unzip archive. Make sure the file is a .parquet.zip exported from OpenTrace. ({e})"
        ) from e

    names = zf.namelist()
    if not names:
        raise ValueError("Archive contains no files.")

    logger.debug("Archive contains %d files: %s", len(names), names)

    nodes: list[dict[str, Any]] = []
    rels: list[dict[str, Any]] = []

    # Read node parquet files
    for name in names:
        if not name.startswith("nodes_") or not name.endswith(".parquet"):
            continue

        node_type = name.removeprefix("nodes_").removesuffix(".parquet")
        _progress(on_progress, f"Reading {node_type} nodes")

        table = pq.read_table(io.BytesIO(zf.read(name)))
        if "id" not in table.column_names:
            logger.warning("Skipping file %s: missing 'id' column", name)
            continue

        has_properties_col = "properties" in table.column_names
        has_name_col = "name" in table.column_names

        for row in table.to_pylist():
            row_id = str(row["id"])
            row_name = str(row.get("name", "")) if has_name_col else ""

            if has_properties_col:
                raw = row["properties"]
                properties = _parse_props(raw) if raw else None
            else:
                # Typed columns — collect everything except id/name into properties
                properties = {}
                for col_name, val in row.items():
                    if col_name in ("id", "name"):
                        continue
                    if val is not None and val != "":
                        properties[col_name] = val
                properties = properties or None

            nodes.append(
                {
                    "id": row_id,
                    "type": node_type,
                    "name": row_name,
                    "properties": properties,
                }
            )

        logger.debug("Read %s: %d rows", node_type, table.num_rows)

    # Read relationships parquet
    if "relationships.parquet" in names:
        _progress(on_progress, "Reading relationships")
        table = pq.read_table(io.BytesIO(zf.read("relationships.parquet")))
        if all(col in table.column_names for col in ("id", "type", "from", "to")):
            for row in table.to_pylist():
                raw_props = row.get("properties")
                properties = _parse_props(raw_props) if raw_props else None

                rels.append(
                    {
                        "id": str(row["id"]),
                        "type": str(row["type"]),
                        "source_id": str(row["from"]),
                        "target_id": str(row["to"]),
                        "properties": properties,
                    }
                )
            logger.debug("Read %d relationships", table.num_rows)
        else:
            logger.warning("relationships.parquet missing required columns")

    zf.close()

    # Import in fixed-size batches to bound memory and transaction size
    _progress(on_progress, f"Importing {len(nodes)} nodes and {len(rels)} relationships")
    result: dict[str, int] = {"nodes_created": 0, "relationships_created": 0, "errors": 0}

    # Nodes first (relationships depend on them)
    for i in range(0, max(len(nodes), 1), _IMPORT_BATCH_SIZE):
        batch = nodes[i : i + _IMPORT_BATCH_SIZE]
        if not batch:
            break
        res = store.import_batch(batch, [])
        result["nodes_created"] += res["nodes_created"]
        result["errors"] += res["errors"]

    # Then relationships
    for i in range(0, max(len(rels), 1), _IMPORT_BATCH_SIZE):
        batch = rels[i : i + _IMPORT_BATCH_SIZE]
        if not batch:
            break
        res = store.import_batch([], batch)
        result["relationships_created"] += res["relationships_created"]
        result["errors"] += res["errors"]

    _progress(on_progress, "Done")

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _progress(callback: Any | None, msg: str) -> None:
    if callback is not None:
        callback(msg)
