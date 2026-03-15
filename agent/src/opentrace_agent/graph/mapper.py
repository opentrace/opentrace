"""GraphMapper: BFS walks tree structures and saves nodes/relationships via MCP."""

from __future__ import annotations

import json
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from opentrace_agent.graph.mcp_client import MCPToolError, SimpleMCPClient
from opentrace_agent.models.base import BaseTreeNode, NodeRelationship, TreeWithOrigin

logger = logging.getLogger(__name__)


@dataclass
class MappingResult:
    """Summary of a graph mapping operation."""

    nodes_created: int = 0
    relationships_created: int = 0
    errors: list[str] = field(default_factory=list)


class GraphMapper:
    """Walks tree structures via BFS and saves nodes + relationships to Neo4j via MCP.

    This is a simplified v1 mapper — no enrichment, no change detection,
    no reconciliation. Those are v2 features.
    """

    def __init__(self, mcp: SimpleMCPClient) -> None:
        self._mcp = mcp

    async def map_trees(self, trees: list[TreeWithOrigin]) -> MappingResult:
        """Map multiple trees to the graph.

        Performs a BFS walk of each tree, saving every node and its
        relationships via the MCP client.
        """
        result = MappingResult()

        for tree in trees:
            logger.info(
                "Mapping tree origin='%s' root='%s'",
                tree.origin,
                tree.root.name,
            )
            await self._walk_tree(tree.root, result)

        logger.info(
            "Mapping complete: %d nodes, %d relationships, %d errors",
            result.nodes_created,
            result.relationships_created,
            len(result.errors),
        )
        return result

    async def _walk_tree(self, root: BaseTreeNode, result: MappingResult) -> None:
        """BFS walk a tree, saving each node and its child relationships."""
        queue: deque[BaseTreeNode] = deque([root])
        visited: set[str] = set()

        while queue:
            node = queue.popleft()
            if node.id in visited:
                continue
            visited.add(node.id)

            # Save the node
            await self._save_node(node, result)

            # Process children
            for child_rel in node.children:
                # Save the child node (will be visited when dequeued)
                queue.append(child_rel.target)

                # Save the relationship
                await self._save_relationship(node, child_rel, result)

    async def _save_node(self, node: BaseTreeNode, result: MappingResult) -> None:
        """Save a single node via MCP."""
        if not node.save_function_name:
            logger.debug("Skipping node '%s' (no save_function_name)", node.id)
            return

        try:
            save_fn = getattr(self._mcp, node.save_function_name)
            await save_fn(
                name=node.graph_name,
                displayName=node.graph_display_name,
                confidence=node.graph_confidence,
                properties=json.dumps(node.graph_properties),
            )
            result.nodes_created += 1
            logger.debug("Saved node '%s' via %s", node.id, node.save_function_name)
        except MCPToolError as e:
            msg = f"Failed to save node '{node.id}': {e}"
            logger.error(msg)
            result.errors.append(msg)
        except Exception as e:
            msg = f"Unexpected error saving node '{node.id}': {e}"
            logger.error(msg)
            result.errors.append(msg)

    async def _save_relationship(
        self,
        parent: BaseTreeNode,
        rel: NodeRelationship[Any],
        result: MappingResult,
    ) -> None:
        """Save a single relationship via MCP."""
        try:
            save_fn = getattr(self._mcp, rel.save_function_name)

            # Direction determines which node is "from" and which is "to"
            if rel.direction == "incoming":
                from_id = rel.target.graph_name
                to_id = parent.graph_name
            else:
                from_id = parent.graph_name
                to_id = rel.target.graph_name

            await save_fn(
                fromNodeId=from_id,
                toNodeId=to_id,
                confidence=rel.confidence,
                properties=json.dumps(rel.graph_properties),
            )
            result.relationships_created += 1
            logger.debug(
                "Saved relationship %s -> %s (%s)",
                from_id,
                to_id,
                rel.relationship,
            )
        except MCPToolError as e:
            msg = f"Failed to save relationship {parent.id} -> {rel.target.id}: {e}"
            logger.error(msg)
            result.errors.append(msg)
        except Exception as e:
            msg = f"Unexpected error saving relationship {parent.id} -> {rel.target.id}: {e}"
            logger.error(msg)
            result.errors.append(msg)
