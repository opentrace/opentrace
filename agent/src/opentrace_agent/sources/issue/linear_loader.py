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

"""Linear issue loader - fetches issues from Linear workspaces."""

from __future__ import annotations

import logging
from typing import Any

from opentrace_agent.models.base import NodeRelationship, TreeWithOrigin
from opentrace_agent.models.nodes import IssueNode, ProjectNode, UserNode
from opentrace_agent.sources.base import Loader

logger = logging.getLogger(__name__)


class LinearIssueLoader(Loader):
    """Loads issues from Linear teams/projects."""

    @property
    def provider_name(self) -> str:
        return "linear"

    async def load(self, config: dict[str, Any]) -> list[TreeWithOrigin]:
        # TODO: Implement actual Linear API integration
        teams = config.get("teams", [])
        if not teams:
            logger.warning("No teams configured for Linear issue loader")
            return []

        trees: list[TreeWithOrigin] = []
        for team_spec in teams:
            team_key = team_spec.get("key", "UNK")
            team_name = team_spec.get("name", team_key)

            project_node = ProjectNode(
                id=f"linear/{team_key}",
                name=team_name,
                url=f"https://linear.app/team/{team_key}",
                provider="linear",
            )

            # Placeholder: one stub issue with an assignee
            issue_node = IssueNode(
                id=f"linear/{team_key}/issues/{team_key}-1",
                name=f"[{team_key}-1] Placeholder issue",
                state="in_progress",
                provider="linear",
                labels=["placeholder"],
            )
            project_node.add_child(NodeRelationship(target=issue_node, relationship="DEFINED_IN"))

            user_node = UserNode(
                id="linear/user/placeholder",
                name="placeholder-user",
                provider="linear",
            )
            issue_node.add_child(NodeRelationship(target=user_node, relationship="ASSIGNED"))

            trees.append(
                TreeWithOrigin(
                    root=project_node,
                    origin="issue",
                    counters={"projects": 1, "issues": 1, "users": 1},
                )
            )
            logger.info("Created placeholder tree for Linear team '%s'", team_name)

        return trees
