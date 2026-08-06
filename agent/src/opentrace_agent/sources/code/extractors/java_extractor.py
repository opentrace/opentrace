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

"""Java symbol extractor using tree-sitter."""

from __future__ import annotations

from typing import ClassVar

import tree_sitter
import tree_sitter_java

from opentrace_agent.sources.code.extractors.base import (
    CallRef,
    CodeSymbol,
    ExtractionResult,
    SymbolExtractor,
)

_PARSER: tree_sitter.Parser | None = None


def _get_parser() -> tree_sitter.Parser:
    global _PARSER
    if _PARSER is None:
        lang = tree_sitter.Language(tree_sitter_java.language())
        _PARSER = tree_sitter.Parser(lang)
    return _PARSER


class JavaExtractor(SymbolExtractor):
    """Extracts class/interface/enum/method symbols from Java source files."""

    extensions: ClassVar[tuple[str, ...]] = (".java",)
    language_name: ClassVar[str] = "java"

    def extract(self, source_bytes: bytes) -> ExtractionResult:
        parser = _get_parser()
        tree = parser.parse(source_bytes)
        symbols = _walk_program(tree.root_node)
        return ExtractionResult(symbols=symbols, language=self.language_name, root_node=tree.root_node)


# ---------------------------------------------------------------------------
# Top-level walk
# ---------------------------------------------------------------------------


def _walk_program(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Walk the root program node and extract top-level declarations."""
    symbols: list[CodeSymbol] = []
    for child in node.children:
        if child.type == "class_declaration":
            sym = _extract_class(child)
            if sym:
                symbols.append(sym)
        elif child.type == "interface_declaration":
            sym = _extract_interface(child)
            if sym:
                symbols.append(sym)
        elif child.type == "enum_declaration":
            sym = _extract_enum(child)
            if sym:
                symbols.append(sym)
    return symbols


# ---------------------------------------------------------------------------
# Class extraction
# ---------------------------------------------------------------------------


def _extract_class(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract a class declaration with its methods, constructors, and inner types."""
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None

    superclasses: list[str] | None = None
    interfaces: list[str] | None = None

    superclass_node = node.child_by_field_name("superclass")
    if superclass_node:
        names = _extract_type_names(superclass_node)
        if names:
            superclasses = names

    interfaces_node = node.child_by_field_name("interfaces")
    if interfaces_node:
        names = _extract_type_names(interfaces_node)
        if names:
            interfaces = names

    docs = _extract_javadoc(node)
    children = _extract_class_body(node.child_by_field_name("body"))

    return CodeSymbol(
        name=name_node.text.decode(),
        kind="class",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        children=children,
        superclasses=superclasses,
        interfaces=interfaces,
        subtype="class",
        docs=docs,
    )


# ---------------------------------------------------------------------------
# Interface extraction
# ---------------------------------------------------------------------------


def _extract_interface(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract an interface declaration with its method signatures."""
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None

    docs = _extract_javadoc(node)

    # Interfaces can extend other interfaces
    interfaces: list[str] | None = None
    extends_node = node.child_by_field_name("interfaces")
    if extends_node:
        names = _extract_type_names(extends_node)
        if names:
            interfaces = names

    children: list[CodeSymbol] = []
    body_node = node.child_by_field_name("body")
    if body_node:
        for child in body_node.children:
            if child.type == "method_declaration":
                sym = _extract_method(child)
                if sym:
                    children.append(sym)

    return CodeSymbol(
        name=name_node.text.decode(),
        kind="class",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        children=children,
        interfaces=interfaces,
        subtype="interface",
        docs=docs,
    )


# ---------------------------------------------------------------------------
# Enum extraction
# ---------------------------------------------------------------------------


def _extract_enum(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract an enum declaration with its methods."""
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None

    docs = _extract_javadoc(node)
    interfaces: list[str] | None = None

    interfaces_node = node.child_by_field_name("interfaces")
    if interfaces_node:
        names = _extract_type_names(interfaces_node)
        if names:
            interfaces = names

    children: list[CodeSymbol] = []
    body_node = node.child_by_field_name("body")
    if body_node:
        for child in body_node.children:
            if child.type == "enum_body_declarations":
                for decl in child.children:
                    if decl.type == "method_declaration":
                        sym = _extract_method(decl)
                        if sym:
                            children.append(sym)
                    elif decl.type == "constructor_declaration":
                        sym = _extract_constructor(decl)
                        if sym:
                            children.append(sym)

    return CodeSymbol(
        name=name_node.text.decode(),
        kind="class",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        children=children,
        interfaces=interfaces,
        subtype="enum",
        docs=docs,
    )


# ---------------------------------------------------------------------------
# Class body
# ---------------------------------------------------------------------------


def _extract_class_body(body_node: tree_sitter.Node | None) -> list[CodeSymbol]:
    """Extract methods, constructors, and inner types from a class body."""
    if body_node is None:
        return []

    children: list[CodeSymbol] = []
    for child in body_node.children:
        if child.type == "method_declaration":
            sym = _extract_method(child)
            if sym:
                children.append(sym)
        elif child.type == "constructor_declaration":
            sym = _extract_constructor(child)
            if sym:
                children.append(sym)
        elif child.type == "class_declaration":
            sym = _extract_class(child)
            if sym:
                children.append(sym)
        elif child.type == "interface_declaration":
            sym = _extract_interface(child)
            if sym:
                children.append(sym)
        elif child.type == "enum_declaration":
            sym = _extract_enum(child)
            if sym:
                children.append(sym)
    return children


# ---------------------------------------------------------------------------
# Method / constructor extraction
# ---------------------------------------------------------------------------


def _extract_method(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract a method declaration."""
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None

    params_node = node.child_by_field_name("parameters")
    signature = params_node.text.decode() if params_node else None
    type_signature = _extract_type_signature(params_node) if params_node else "()"

    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []

    docs = _extract_javadoc(node)
    return_type = _extract_return_type(node)

    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
        docs=docs,
        type_signature=type_signature,
        return_type=return_type,
    )


def _extract_constructor(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract a constructor declaration (treated as a function named <init>)."""
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None

    params_node = node.child_by_field_name("parameters")
    signature = params_node.text.decode() if params_node else None
    type_signature = _extract_type_signature(params_node) if params_node else "()"

    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []

    docs = _extract_javadoc(node)

    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
        docs=docs,
        type_signature=type_signature,
        return_type=None,  # constructors have no return type
    )


# ---------------------------------------------------------------------------
# Type signature (for overload disambiguation)
# ---------------------------------------------------------------------------


def _extract_type_signature(params_node: tree_sitter.Node) -> str:
    """Build a type signature from Java formal parameters, e.g. ``(String,int)``."""
    types: list[str] = []
    for child in params_node.children:
        if child.type == "formal_parameter":
            type_node = child.child_by_field_name("type")
            if type_node:
                types.append(_normalize_java_type(type_node))
        elif child.type == "spread_parameter":
            # varargs: String... args
            type_node = child.child_by_field_name("type") or next(
                (c for c in child.children if c.is_named and c.type != "variable_declarator"),
                None,
            )
            if type_node:
                types.append(_normalize_java_type(type_node) + "...")
    return f"({','.join(types)})"


def _normalize_java_type(type_node: tree_sitter.Node) -> str:
    """Normalize a Java type node to a short type name.

    Strips generics: ``List<String>`` → ``List``.
    Strips qualifiers: ``java.util.Map`` → ``Map``.
    Handles arrays: ``String[]`` → ``String[]``.
    """
    if type_node.type == "generic_type":
        # Use the base type, ignoring type_arguments
        for child in type_node.children:
            if child.type == "type_identifier":
                return child.text.decode()
            if child.type == "scoped_type_identifier":
                return _last_identifier(child)
        return type_node.text.decode()
    if type_node.type == "array_type":
        element = type_node.child_by_field_name("element")
        dimensions = type_node.child_by_field_name("dimensions")
        base = _normalize_java_type(element) if element else type_node.text.decode()
        dim_str = dimensions.text.decode() if dimensions else "[]"
        return base + dim_str
    if type_node.type == "scoped_type_identifier":
        return _last_identifier(type_node)
    if type_node.type in ("type_identifier", "integral_type", "floating_point_type", "boolean_type"):
        return type_node.text.decode()
    if type_node.type == "void_type":
        return "void"
    # Fallback: use the raw text
    return type_node.text.decode()


def _last_identifier(node: tree_sitter.Node) -> str:
    """Extract the last identifier from a scoped name (``a.b.C`` → ``C``)."""
    text = node.text.decode()
    return text.rsplit(".", 1)[-1]


# ---------------------------------------------------------------------------
# Return type extraction
# ---------------------------------------------------------------------------


def _extract_return_type(node: tree_sitter.Node) -> str | None:
    """Extract the return type from a Java method declaration.

    The ``type`` field on a method_declaration holds the return type.
    """
    type_node = node.child_by_field_name("type")
    if type_node is None:
        return None
    normalized = _normalize_java_type(type_node)
    if normalized == "void":
        return "void"
    return normalized


# ---------------------------------------------------------------------------
# Superclass / interface extraction
# ---------------------------------------------------------------------------


def _extract_type_names(node: tree_sitter.Node) -> list[str]:
    """Extract type names from a superclass or super_interfaces node.

    Handles ``extends Base``, ``implements Foo, Bar<T>``, ``extends A, B``.
    """
    names: list[str] = []
    for child in node.children:
        if child.type == "type_identifier":
            names.append(child.text.decode())
        elif child.type == "generic_type":
            # Strip generics: Comparable<Foo> → Comparable
            for sub in child.children:
                if sub.type == "type_identifier":
                    names.append(sub.text.decode())
                    break
        elif child.type == "scoped_type_identifier":
            names.append(_last_identifier(child))
        elif child.type == "type_list":
            names.extend(_extract_type_names(child))
    return names


# ---------------------------------------------------------------------------
# Javadoc extraction
# ---------------------------------------------------------------------------


def _extract_javadoc(node: tree_sitter.Node) -> str | None:
    """Extract a Javadoc comment (``/** ... */``) from the preceding sibling.

    Also handles regular block comments (``/* ... */``) and consecutive
    line comments (``// ...``) immediately above the declaration.
    """
    sibling = node.prev_named_sibling
    if sibling is None:
        # Inside a class body the Javadoc may be an unnamed sibling;
        # check the parent's children list for a block_comment just before us.
        parent = node.parent
        if parent is not None:
            prev = None
            for child in parent.children:
                if child.id == node.id:
                    break
                if child.is_named:
                    prev = child
            sibling = prev

    if sibling is None:
        return None

    if sibling.type == "block_comment":
        # Must be immediately above (no blank-line gap or intervening declarations)
        if sibling.end_point.row + 1 < node.start_point.row:
            # Allow at most 1 blank line between comment and declaration
            if node.start_point.row - sibling.end_point.row > 2:
                return None
        return _clean_javadoc(sibling.text.decode())

    # Consecutive line comments
    if sibling.type == "line_comment":
        lines: list[str] = []
        expected_row = node.start_point.row - 1
        current = sibling
        while current is not None and current.type == "line_comment":
            if current.end_point.row != expected_row:
                break
            text = current.text.decode()
            if text.startswith("//"):
                lines.append(text[2:].strip())
            expected_row = current.start_point.row - 1
            current = current.prev_named_sibling
        if lines:
            lines.reverse()
            return "\n".join(lines)

    return None


def _clean_javadoc(text: str) -> str:
    """Strip Javadoc delimiters and leading asterisks.

    ``/** Foo bar. */`` → ``Foo bar.``
    """
    # Remove /** and */
    if text.startswith("/**"):
        text = text[3:]
    elif text.startswith("/*"):
        text = text[2:]
    if text.endswith("*/"):
        text = text[:-2]

    lines: list[str] = []
    for line in text.split("\n"):
        stripped = line.strip()
        # Remove leading * common in Javadoc
        if stripped.startswith("*"):
            stripped = stripped[1:].strip()
        if stripped:
            lines.append(stripped)

    return "\n".join(lines) if lines else ""


# ---------------------------------------------------------------------------
# Call extraction
# ---------------------------------------------------------------------------


def _extract_call_from_node(node: tree_sitter.Node) -> CallRef | None:
    """Extract a single CallRef if ``node`` is a Java method_invocation.

    Returns None for non-call nodes.
    """
    if node.type != "method_invocation":
        return None

    name_node = node.child_by_field_name("name")
    if not name_node:
        return None

    object_node = node.child_by_field_name("object")
    if object_node:
        # Dotted call: obj.method() or this.method()
        receiver = object_node.text.decode()
        return CallRef(
            name=name_node.text.decode(),
            receiver=receiver,
            kind="attribute",
        )
    else:
        # Bare call: method()
        return CallRef(name=name_node.text.decode())


def _collect_calls(node: tree_sitter.Node) -> list[CallRef]:
    """Collect method call references from a tree-sitter subtree.

    Captures bare calls (``foo()``), dotted calls (``obj.foo()``),
    and chained calls (``a.b().c()``).
    """
    calls: list[CallRef] = []
    own = _extract_call_from_node(node)
    if own is not None:
        calls.append(own)
    for child in node.children:
        calls.extend(_collect_calls(child))
    return calls
