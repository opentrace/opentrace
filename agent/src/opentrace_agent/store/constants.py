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

Mirrors the Go ``ValidNodeTypes`` allowlist in ``api/pkg/graph/types.go``
so that databases created by either backend are interoperable.
"""

VALID_NODE_TYPES = {
    "Service",
    "Repo",
    "Repository",
    "Class",
    "Module",
    "Function",
    "File",
    "Directory",
    "Package",
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
    "Variable",
}
