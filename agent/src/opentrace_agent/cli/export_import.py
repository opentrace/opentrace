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


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def export_database(store: GraphStore) -> bytes:
    """Export the entire graph as a ``.parquet.zip`` archive.

    Returns the zip bytes ready to be written to a file.
    """
    stats = store.get_stats()
    if stats["total_nodes"] == 0:
        raise ValueError("Nothing to export — the graph is empty.")

    buffers: dict[str, bytes] = {}

    # Group nodes by type and write one parquet file per type
    for node_type, count in stats["nodes_by_type"].items():
        nodes = store.list_nodes(node_type, limit=count + 1000)
        if not nodes:
            continue

        ids: list[str] = []
        names: list[str] = []
        props: list[str] = []
        for n in nodes:
            ids.append(n["id"])
            names.append(n["name"])
            props.append(_marshal_props(n.get("properties")))

        table = pa.table(
            {"id": pa.array(ids), "name": pa.array(names), "properties": pa.array(props)},
        )
        buf = io.BytesIO()
        pq.write_table(table, buf)
        buffers[f"nodes_{node_type}.parquet"] = buf.getvalue()
        logger.debug("Exported %s: %d nodes", node_type, len(nodes))

    # Export relationships
    rels = _list_all_relationships_unlimited(store)
    if rels:
        froms: list[str] = []
        tos: list[str] = []
        rel_ids: list[str] = []
        types: list[str] = []
        rel_props: list[str] = []
        for r in rels:
            froms.append(r["source_id"])
            tos.append(r["target_id"])
            rel_ids.append(r["id"])
            types.append(r["type"])
            rel_props.append(_marshal_props(r.get("properties")))

        table = pa.table(
            {
                "from": pa.array(froms),
                "to": pa.array(tos),
                "id": pa.array(rel_ids),
                "type": pa.array(types),
                "properties": pa.array(rel_props),
            }
        )
        buf = io.BytesIO()
        pq.write_table(table, buf)
        buffers["relationships.parquet"] = buf.getvalue()
        logger.debug("Exported %d relationships", len(rels))

    # Zip all parquet files
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for name, data in buffers.items():
            zf.writestr(name, data)

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

        has_properties_col = "properties" in table.column_names
        for i in range(table.num_rows):
            row_id = str(table.column("id")[i].as_py())
            row_name = str(table.column("name")[i].as_py()) if "name" in table.column_names else ""

            if has_properties_col:
                raw = table.column("properties")[i].as_py()
                properties = _parse_props(raw) if raw else None
            else:
                # Typed columns — collect everything except id/name into properties
                properties = {}
                for col_name in table.column_names:
                    if col_name in ("id", "name"):
                        continue
                    val = table.column(col_name)[i].as_py()
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

        for i in range(table.num_rows):
            raw_props = table.column("properties")[i].as_py() if "properties" in table.column_names else None
            properties = _parse_props(raw_props) if raw_props else None

            rels.append(
                {
                    "id": str(table.column("id")[i].as_py()),
                    "type": str(table.column("type")[i].as_py()),
                    "source_id": str(table.column("from")[i].as_py()),
                    "target_id": str(table.column("to")[i].as_py()),
                    "properties": properties,
                }
            )

        logger.debug("Read %d relationships", table.num_rows)

    zf.close()

    # Import in batches
    _progress(on_progress, f"Importing {len(nodes)} nodes and {len(rels)} relationships")
    result = store.import_batch(nodes, rels)
    _progress(on_progress, "Done")

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _list_all_relationships_unlimited(store: GraphStore) -> list[dict[str, Any]]:
    """Fetch all relationships without a hard limit.

    Uses get_stats to determine total_edges and requests enough.
    """
    stats = store.get_stats()
    total = stats["total_edges"]
    if total == 0:
        return []
    # Access the private helper with a generous limit
    return store._list_all_relationships(total + 1000)


def _progress(callback: Any | None, msg: str) -> None:
    if callback is not None:
        callback(msg)
