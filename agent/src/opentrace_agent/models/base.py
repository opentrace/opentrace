"""Tree node models for representing code and architectural elements.

Supports a flexible hierarchy of node types including repos, files, classes,
functions, issues and more. IDs are source-specific and recreatable.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import (
    Any,
    ClassVar,
    Generic,
    Literal,
    Optional,
    Sequence,
    Type,
    TypeVar,
    cast,
)

logger = logging.getLogger(__name__)

NodeType = TypeVar("NodeType", bound="BaseTreeNode", covariant=True)
T = TypeVar("T", bound="BaseTreeNode")

RelationType = Literal[
    "DEFINED_IN",
    "DEPENDS_ON",
    "CALLS",
    "EXTENDS",
    "PART_OF",
    "AUTHORED",
    "ASSIGNED",
    "PARENT_OF",
    "PARTICIPATED",
]

relationship_mapping: dict[str, str] = {
    "DEFINED_IN": "save_defined_in_relationship",
    "PART_OF": "save_part_of_relationship",
    "CALLS": "save_calls_relationship",
    "DEPENDS_ON": "save_relates_relationship",
    "EXTENDS": "save_relates_relationship",
    "AUTHORED": "save_authored_relationship",
    "ASSIGNED": "save_assigned_relationship",
    "PARENT_OF": "save_part_of_relationship",
    "PARTICIPATED": "save_participated_relationship",
}


@dataclass
class TreeWithOrigin:
    """Pairs a tree root with its origin identifier for reconciliation scoping.

    Origin is used to isolate reconciliation operations to nodes from the same
    data source, preventing cross-tree interference when multiple trees share
    the same root node (e.g., code tree and issue tree both rooted at RepoNode).
    """

    root: BaseTreeNode
    origin: str  # e.g., "code", "issue", "directory"

    counters: dict[str, int] = field(default_factory=dict)
    """Domain-specific metrics, e.g. {"projects": 1, "errors": 42}."""


@dataclass
class NodeRelationship(Generic[NodeType]):
    """Represents a relationship between two nodes in the tree.

    Models explicit relationships that will be created in the knowledge graph.
    Supports multiple relationship types beyond just parent-child hierarchies.
    """

    schema_version: ClassVar[str] = "1"

    target: NodeType
    """The node this relationship points to."""

    relationship: RelationType
    """Neo4j relationship type (e.g., 'DEFINED_IN', 'DEPENDS_ON')."""

    confidence: float = 1.0
    """Confidence score for this relationship (0.0 to 1.0)."""

    properties: dict[str, Any] = field(default_factory=dict)
    """Additional metadata to store on the relationship."""

    direction: Literal["outgoing", "incoming"] = "incoming"
    """Direction: 'outgoing' (parent->target) or 'incoming' (target->parent)."""

    @property
    def save_function_name(self) -> str:
        operation = relationship_mapping.get(self.relationship)
        if not operation:
            raise ValueError(
                f"Could not determine MCP operation for relationship type: {self.relationship}"
            )
        return operation

    @property
    def graph_properties(self) -> dict[str, Any]:
        return dict(self.properties)


@dataclass
class BaseTreeNode:
    """Base node containing common attributes for all tree nodes.

    When subclassing, set graph_type and save_function_name class variables,
    and add node-specific attributes as needed.
    """

    graph_type: ClassVar[str] = ""
    """Graph type name for this node type. Override in subclasses."""

    save_function_name: ClassVar[str] = ""
    """MCP save operation name for this node type. Override in subclasses."""

    id: str
    """Unique identifier for the node. Must be source-specific and recreatable."""

    name: str
    """Human-readable name for the node."""

    parent: Optional[BaseTreeNode] = None
    """Parent node in the tree."""

    children: Sequence[NodeRelationship[BaseTreeNode]] = field(default_factory=list)
    """Relationships to child nodes."""

    content_hash: Optional[str] = None
    """SHA-256 hash of the node's content for change detection."""

    def __post_init__(self) -> None:
        if self.__class__ is not BaseTreeNode:
            if not self.__class__.graph_type:
                raise ValueError(
                    f"{self.__class__.__name__} must define 'graph_type' class variable"
                )
            if not self.__class__.save_function_name:
                raise ValueError(
                    f"{self.__class__.__name__} must define 'save_function_name' class variable"
                )

    @property
    def type(self) -> str:
        return self.__class__.__name__

    @property
    def graph_name(self) -> str:
        return self.id

    @property
    def graph_display_name(self) -> str:
        return self.name

    @property
    def graph_confidence(self) -> float:
        return 1.0

    @property
    def graph_properties(self) -> dict[str, Any]:
        props: dict[str, Any] = {}
        if self.content_hash:
            props["content_hash"] = self.content_hash
        return props

    def find_parent(self, parent_type: Type[T]) -> Optional[T]:
        if self.parent is None:
            return None
        if isinstance(self.parent, parent_type):
            return cast(T, self.parent)
        return self.parent.find_parent(parent_type)

    def add_child(self, child: NodeRelationship[BaseTreeNode]) -> None:
        child.target.parent = self
        cast(list, self.children).append(child)


def calculate_string_hash(content: str) -> str:
    if content == "":
        return ""
    return hashlib.sha256(content.encode()).hexdigest()
