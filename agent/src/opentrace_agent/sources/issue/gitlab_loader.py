"""GitLab issue loader - fetches issues from GitLab projects."""

from __future__ import annotations

import logging
from typing import Any

from opentrace_agent.models.base import NodeRelationship, TreeWithOrigin
from opentrace_agent.models.nodes import IssueNode, ProjectNode, UserNode
from opentrace_agent.sources.base import Loader

logger = logging.getLogger(__name__)


class GitLabIssueLoader(Loader):
    """Loads issues from GitLab projects."""

    @property
    def provider_name(self) -> str:
        return "gitlab"

    async def load(self, config: dict[str, Any]) -> list[TreeWithOrigin]:
        # TODO: Implement actual GitLab API integration
        projects = config.get("projects", [])
        if not projects:
            logger.warning("No projects configured for GitLab issue loader")
            return []

        trees: list[TreeWithOrigin] = []
        for project_spec in projects:
            project_id = project_spec.get("id", "unknown")
            project_name = project_spec.get("name", project_id)

            project_node = ProjectNode(
                id=f"gitlab/{project_id}",
                name=project_name,
                url=project_spec.get("url"),
                provider="gitlab",
            )

            # Placeholder: one stub issue with an assignee
            issue_node = IssueNode(
                id=f"gitlab/{project_id}/issues/1",
                name=f"[{project_name}] Placeholder issue #1",
                url=f"https://gitlab.com/{project_id}/-/issues/1",
                state="open",
                provider="gitlab",
            )
            project_node.add_child(
                NodeRelationship(target=issue_node, relationship="DEFINED_IN")
            )

            user_node = UserNode(
                id="gitlab/user/placeholder",
                name="placeholder-user",
                provider="gitlab",
            )
            issue_node.add_child(
                NodeRelationship(target=user_node, relationship="ASSIGNED")
            )

            trees.append(
                TreeWithOrigin(
                    root=project_node,
                    origin="issue",
                    counters={"projects": 1, "issues": 1, "users": 1},
                )
            )
            logger.info(
                "Created placeholder tree for GitLab project '%s'", project_name
            )

        return trees
