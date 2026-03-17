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

"""Agent state definition for the LangGraph pipeline."""

from __future__ import annotations

from typing import Any, TypedDict

from opentrace_agent.graph.mapper import MappingResult
from opentrace_agent.models.base import TreeWithOrigin


class AgentState(TypedDict, total=False):
    """State flowing through the plan → load → map pipeline."""

    # Input
    sources_config: dict[str, Any]
    """Per-source-type config, e.g. {"code": {"github": {...}}, "issue": {"linear": {...}}}."""

    # Plan output
    sources_to_run: list[str]
    """Source types that have matching loader configs (e.g. ["code", "issue"])."""

    # Load output
    trees: list[TreeWithOrigin]
    """Aggregated trees from all loaders."""

    # Map output
    mapping_result: MappingResult | None
    """Summary of the graph mapping operation."""

    # Errors accumulated across all phases
    errors: list[str]
