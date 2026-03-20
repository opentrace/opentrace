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

"""Concrete tree node types for code, issue, and organizational elements."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Optional

from opentrace_agent.models.base import BaseTreeNode


@dataclass
class RepoNode(BaseTreeNode):
    """Represents a source code repository."""

    graph_type: ClassVar[str] = "Repository"
    save_function_name: ClassVar[str] = "save_repository_node"

    url: Optional[str] = None
    default_branch: Optional[str] = None
    summary: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.url:
            props["url"] = self.url
        if self.default_branch:
            props["default_branch"] = self.default_branch
        if self.summary:
            props["summary"] = self.summary
        return props


@dataclass
class DirectoryNode(BaseTreeNode):
    """Represents a directory in a repository."""

    graph_type: ClassVar[str] = "Directory"
    save_function_name: ClassVar[str] = "save_directory_node"

    path: str = ""
    summary: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.path:
            props["path"] = self.path
        if self.summary:
            props["summary"] = self.summary
        return props


@dataclass
class FileNode(BaseTreeNode):
    """Represents a source file."""

    graph_type: ClassVar[str] = "File"
    save_function_name: ClassVar[str] = "save_file_node"

    path: str = ""
    extension: Optional[str] = None
    language: Optional[str] = None
    abs_path: Optional[str] = None  # transient, used during indexing only
    summary: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.path:
            props["path"] = self.path
        if self.extension:
            props["extension"] = self.extension
        if self.language:
            props["language"] = self.language
        if self.summary:
            props["summary"] = self.summary
        return props


@dataclass
class ClassNode(BaseTreeNode):
    """Represents a class definition."""

    graph_type: ClassVar[str] = "Class"
    save_function_name: ClassVar[str] = "save_class_node"

    language: Optional[str] = None
    start_line: Optional[int] = None
    end_line: Optional[int] = None
    summary: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.language:
            props["language"] = self.language
        if self.start_line is not None:
            props["start_line"] = self.start_line
        if self.end_line is not None:
            props["end_line"] = self.end_line
        if self.summary:
            props["summary"] = self.summary
        return props


@dataclass
class FunctionNode(BaseTreeNode):
    """Represents a function or method definition."""

    graph_type: ClassVar[str] = "Function"
    save_function_name: ClassVar[str] = "save_function_node"

    language: Optional[str] = None
    start_line: Optional[int] = None
    end_line: Optional[int] = None
    signature: Optional[str] = None
    summary: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.language:
            props["language"] = self.language
        if self.start_line is not None:
            props["start_line"] = self.start_line
        if self.end_line is not None:
            props["end_line"] = self.end_line
        if self.signature:
            props["signature"] = self.signature
        if self.summary:
            props["summary"] = self.summary
        return props


@dataclass
class VariableNode(BaseTreeNode):
    """Represents a variable definition within a function or class."""

    graph_type: ClassVar[str] = "Variable"
    save_function_name: ClassVar[str] = "save_variable_node"

    language: Optional[str] = None
    line: Optional[int] = None
    var_type: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.language:
            props["language"] = self.language
        if self.line is not None:
            props["line"] = self.line
        if self.var_type:
            props["var_type"] = self.var_type
        return props


@dataclass
class ProjectNode(BaseTreeNode):
    """Represents a project (e.g., Linear project, GitHub project)."""

    graph_type: ClassVar[str] = "Project"
    save_function_name: ClassVar[str] = "save_project_node"

    url: Optional[str] = None
    provider: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.url:
            props["url"] = self.url
        if self.provider:
            props["provider"] = self.provider
        return props


@dataclass
class IssueNode(BaseTreeNode):
    """Represents an issue or ticket."""

    graph_type: ClassVar[str] = "Issue"
    save_function_name: ClassVar[str] = "save_issue_node"

    url: Optional[str] = None
    state: Optional[str] = None
    provider: Optional[str] = None
    labels: list[str] = field(default_factory=list)

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.url:
            props["url"] = self.url
        if self.state:
            props["state"] = self.state
        if self.provider:
            props["provider"] = self.provider
        if self.labels:
            props["labels"] = self.labels
        return props


@dataclass
class CommentNode(BaseTreeNode):
    """Represents a comment on an issue or PR."""

    graph_type: ClassVar[str] = "Comment"
    save_function_name: ClassVar[str] = "save_comment_node"

    body: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.body:
            props["body"] = self.body
        return props


@dataclass
class UserNode(BaseTreeNode):
    """Represents a user or contributor."""

    graph_type: ClassVar[str] = "User"
    save_function_name: ClassVar[str] = "save_user_node"

    email: Optional[str] = None
    provider: Optional[str] = None

    @property
    def graph_properties(self) -> dict[str, Any]:
        props = super().graph_properties
        if self.email:
            props["email"] = self.email
        if self.provider:
            props["provider"] = self.provider
        return props
