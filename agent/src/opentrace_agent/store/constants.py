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

"""Valid node types for the OpenTrace knowledge graph.

Derived from the proto-generated schema (code_graph.proto) plus
legacy runtime types (Service, Span, etc.) for backward compat.
"""

from opentrace_agent.gen.schema_gen import NODE_TYPE_INDEX_METADATA
from opentrace_agent.gen.schema_gen import NODE_TYPES as _PROTO_NODE_TYPES

# Internal node types — valid in the DB but excluded from graph queries, stats, and search.
INTERNAL_NODE_TYPES = {NODE_TYPE_INDEX_METADATA}

# Proto-defined code graph types + legacy runtime graph types
VALID_NODE_TYPES = {
    *(t for t in _PROTO_NODE_TYPES if t not in INTERNAL_NODE_TYPES),
    # Legacy aliases (accepted on input, not emitted)
    "Repo",
    "Package",
    # Runtime / observability types (not in code_graph.proto)
    "Service",
    "Cluster",
    "Namespace",
    "Deployment",
    "InstrumentedService",
    "Span",
    "Log",
    "Metric",
    "Endpoint",
    "Database",
    "DBTable",
}
