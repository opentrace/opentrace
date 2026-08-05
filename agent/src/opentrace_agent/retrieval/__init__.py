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

"""Read-only graph-analysis primitives.

Each function takes a :class:`opentrace_agent.store.GraphStore` and returns
plain dicts/lists ready to be JSON-serialised for a CLI or API response.
Read-only by construction — nothing in this package writes to the store —
and following the store/CLAUDE.md convention of parameterised values with
hardcoded labels.

Two modules today:

* ``communities`` — structure *within* the detected community partition:
  degree-ranked hub nodes and the edges that span two communities.
* ``cross_domain`` — structure *across* node-type domains, e.g. an edge that
  joins the code domain to another, and communities whose membership spans
  more than one.

Both depend on a community partition existing, which ``opentraceai cluster``
writes. Without it, ``god_nodes`` still works (pure degree ranking) while the
bridge and spanning-community helpers return empty.
"""

from opentrace_agent.retrieval.communities import (
    cross_community_bridges,
    god_nodes,
    list_communities,
)
from opentrace_agent.retrieval.cross_domain import (
    cross_domain_bridges,
    find_communities_spanning_domains,
)

__all__ = [
    "cross_community_bridges",
    "cross_domain_bridges",
    "find_communities_spanning_domains",
    "god_nodes",
    "list_communities",
]
