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

"""Agent-facing graph-retrieval primitives (OT-1732).

Each function takes a :class:`opentrace_agent.store.GraphStore` and returns
a dict ready to be JSON-serialised for an MCP/REST response. Functions are
read-only by construction and follow the store/CLAUDE.md convention of
parameterised values + hardcoded labels.
"""

from opentrace_agent.retrieval.clusters import (
    cross_cluster_bridges,
    god_nodes,
    list_clusters,
)
from opentrace_agent.retrieval.counts import count_by
from opentrace_agent.retrieval.cross_domain import (
    cross_domain_bridges,
    find_clusters_spanning_domains,
)
from opentrace_agent.retrieval.existence import find_orphans
from opentrace_agent.retrieval.grep import grep
from opentrace_agent.retrieval.overview import overview
from opentrace_agent.retrieval.paths import find_path, find_via_relationship_to_type
from opentrace_agent.retrieval.provenance import provenance
from opentrace_agent.retrieval.search import search

__all__ = [
    "count_by",
    "cross_cluster_bridges",
    "cross_domain_bridges",
    "find_clusters_spanning_domains",
    "find_orphans",
    "find_path",
    "find_via_relationship_to_type",
    "god_nodes",
    "grep",
    "list_clusters",
    "overview",
    "provenance",
    "search",
]
