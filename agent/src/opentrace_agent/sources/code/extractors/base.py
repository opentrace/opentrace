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

"""Base abstractions for tree-sitter symbol extraction."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal


@dataclass
class CallArg:
    """An argument passed to a function/method call.

    Captures variable references used as arguments so we can trace
    data flow from variable definitions through call sites.
    """

    name: str
    """The argument text (variable name or expression)."""

    kind: Literal["variable", "literal", "call", "other"] = "variable"
    """What kind of argument: a variable reference, literal value, nested call, etc."""


@dataclass
class CallRef:
    """A reference to a function/method call found in source code.

    Captures enough context for downstream resolution without losing
    information about how the call was written.
    """

    name: str
    """The function/method name (e.g. "validate", "Println")."""

    receiver: str | None = None
    """The object/module prefix (e.g. "self", "this", "fmt", "s", None)."""

    kind: Literal["bare", "attribute"] = "bare"
    """Whether this is a bare call (foo()) or dotted call (obj.foo())."""

    arguments: list[CallArg] = field(default_factory=list)
    """Arguments passed to this call, for tracing variable usage."""


@dataclass
class VariableRef:
    """A variable assignment found in source code.

    Represents a local variable, attribute assignment, or annotated
    assignment so we can build DEFINED_IN relationships from variables
    back to their enclosing scope.
    """

    name: str
    """The variable name (e.g. 'result', 'self.x')."""

    line: int
    """1-indexed line number of the assignment."""

    type_annotation: str | None = None
    """Type annotation if present (e.g. 'int', 'str')."""


@dataclass
class CodeSymbol:
    """A symbol (class/function) extracted from source code."""

    name: str
    kind: Literal["class", "function"]
    start_line: int
    end_line: int
    signature: str | None = None
    children: list[CodeSymbol] = field(default_factory=list)
    calls: list[CallRef] = field(default_factory=list)
    variables: list[VariableRef] = field(default_factory=list)
    """Variables defined within this symbol's scope."""
    receiver_var: str | None = None
    """Go-specific: the receiver variable name (e.g. 's' from '(s *Server)')."""
    receiver_type: str | None = None
    """Go-specific: the receiver type name (e.g. 'Server' from '(s *Server)')."""
    param_types: dict[str, str] | None = None
    """Parameter name → type name mapping from type annotations (leaf of dotted types)."""
    superclasses: list[str] | None = None
    """Base classes (Python: class Foo(Bar), Go: embedded structs, TS: extends)."""
    interfaces: list[str] | None = None
    """Implemented interfaces (Go: embedded interfaces, TS: implements)."""
    subtype: str | None = None
    """Structural subtype: "struct", "interface", "enum", etc."""
    docs: str | None = None
    """Docstring or doc-comment text."""


@dataclass
class ExtractionResult:
    """Result of extracting symbols from a source file."""

    symbols: list[CodeSymbol]
    language: str
    root_node: Any = None
    """Tree-sitter root node, preserved for import analysis reuse."""


class SymbolExtractor(ABC):
    """Abstract base for language-specific symbol extractors."""

    extensions: ClassVar[tuple[str, ...]]
    language_name: ClassVar[str]

    @abstractmethod
    def extract(self, source_bytes: bytes) -> ExtractionResult:
        """Parse source bytes and return extracted symbols."""
        ...

    def can_handle(self, extension: str) -> bool:
        """Check if this extractor handles the given file extension."""
        return extension in self.extensions
