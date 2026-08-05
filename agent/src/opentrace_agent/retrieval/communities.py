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

"""Knowledge-graph highlights — communities, god nodes, bridges.

Thin typed helpers on top of the equivalent ``GraphStore`` methods. Lives
here so the retrieval/ surface owns the API for MCP / REST / UI clients,
matching the convention already established by ``search``, ``overview``,
``paths``, etc. The underlying Cypher still lives in ``graph_store.py``
because these queries depend on internal label / rel-type constants.
"""

from __future__ import annotations

from typing import Any

from opentrace_agent.store import GraphStore


def list_communities(store: GraphStore) -> list[dict[str, Any]]:
    """Return all detected Community nodes ordered by community_id."""
    return store.list_communities()


def god_nodes(
    store: GraphStore,
    limit: int = 20,
    exclude_types: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    """Return the top-degree non-synthetic nodes — centrality hubs."""
    return store.list_god_nodes(limit=limit, exclude_types=exclude_types)


def cross_community_bridges(
    store: GraphStore,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return edges whose endpoints belong to different communities."""
    return store.list_cross_community_bridges(limit=limit)
