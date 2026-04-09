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

"""Go symbol extractor using tree-sitter."""

from __future__ import annotations

from typing import ClassVar

import tree_sitter
import tree_sitter_go

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
        lang = tree_sitter.Language(tree_sitter_go.language())
        _PARSER = tree_sitter.Parser(lang)
    return _PARSER


class GoExtractor(SymbolExtractor):
    """Extracts struct/function symbols from Go source files."""

    extensions: ClassVar[tuple[str, ...]] = (".go",)
    language_name: ClassVar[str] = "go"

    def extract(self, source_bytes: bytes) -> ExtractionResult:
        parser = _get_parser()
        tree = parser.parse(source_bytes)
        symbols = _walk_node(tree.root_node)
        return ExtractionResult(symbols=symbols, language=self.language_name, root_node=tree.root_node)


def _walk_node(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Walk a tree-sitter node and extract struct/function symbols."""
    symbols: list[CodeSymbol] = []
    for child in node.children:
        if child.type == "type_declaration":
            sym = _extract_type_decl(child)
            if sym:
                symbols.append(sym)
        elif child.type == "function_declaration":
            sym = _extract_function(child)
            if sym:
                symbols.append(sym)
        elif child.type == "method_declaration":
            sym = _extract_method(child)
            if sym:
                symbols.append(sym)
    return symbols


def _extract_type_decl(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract a type declaration (struct, interface)."""
    for child in node.children:
        if child.type == "type_spec":
            name_node = child.child_by_field_name("name")
            if not name_node:
                continue
            # Check if it's a struct or interface
            type_node = child.child_by_field_name("type")
            if type_node and type_node.type in ("struct_type", "interface_type"):
                is_interface = type_node.type == "interface_type"
                methods = _extract_interface_methods(type_node) if is_interface else []
                subtype = "interface" if is_interface else "struct"
                superclasses: list[str] | None = None
                interfaces: list[str] | None = None
                if is_interface:
                    interfaces = _extract_embedded_interfaces(type_node)
                else:
                    superclasses = _extract_embedded_structs(type_node)
                docs = _extract_godoc(node)
                return CodeSymbol(
                    name=name_node.text.decode(),
                    kind="class",
                    start_line=node.start_point.row + 1,
                    end_line=node.end_point.row + 1,
                    children=methods,
                    subtype=subtype,
                    superclasses=superclasses,
                    interfaces=interfaces,
                    docs=docs,
                )
    return None


def _extract_interface_methods(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Extract method signatures from an interface type."""
    methods: list[CodeSymbol] = []
    for child in node.children:
        if child.type == "method_elem":
            name_node = child.child_by_field_name("name")
            if name_node:
                params_node = child.child_by_field_name("parameters")
                signature = params_node.text.decode() if params_node else None
                methods.append(
                    CodeSymbol(
                        name=name_node.text.decode(),
                        kind="function",
                        start_line=child.start_point.row + 1,
                        end_line=child.end_point.row + 1,
                        signature=signature,
                    )
                )
    return methods


def _extract_function(node: tree_sitter.Node) -> CodeSymbol | None:
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    params_node = node.child_by_field_name("parameters")
    signature = params_node.text.decode() if params_node else None
    type_signature = _extract_go_type_signature(params_node) if params_node else "()"
    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    docs = _extract_godoc(node)
    return_type = _extract_go_return_type(node)
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


def _extract_method(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract a method declaration (func (receiver) Name(...) ...)."""
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    params_node = node.child_by_field_name("parameters")
    receiver_node = node.child_by_field_name("receiver")
    signature = params_node.text.decode() if params_node else None
    receiver_var: str | None = None
    receiver_type: str | None = None
    if receiver_node:
        receiver_var, receiver_type = _parse_receiver(receiver_node)
    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    docs = _extract_godoc(node)
    type_signature = _extract_go_type_signature(params_node) if params_node else "()"
    return_type = _extract_go_return_type(node)
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
        receiver_var=receiver_var,
        receiver_type=receiver_type,
        docs=docs,
        type_signature=type_signature,
        return_type=return_type,
    )


def _parse_receiver(receiver_node: tree_sitter.Node) -> tuple[str | None, str | None]:
    """Parse receiver variable and type from a Go method receiver.

    Handles forms like ``(s *Server)``, ``(s Server)``, ``(h *Handler)``.
    Returns (var_name, type_name).
    """
    for child in receiver_node.children:
        if child.type == "parameter_declaration":
            var_name: str | None = None
            type_name: str | None = None
            name_child = child.child_by_field_name("name")
            if name_child:
                var_name = name_child.text.decode()
            type_child = child.child_by_field_name("type")
            if type_child:
                # Handle pointer types like *Server
                if type_child.type == "pointer_type":
                    for sub in type_child.children:
                        if sub.type == "type_identifier":
                            type_name = sub.text.decode()
                            break
                elif type_child.type == "type_identifier":
                    type_name = type_child.text.decode()
            return var_name, type_name
    return None, None


def _extract_go_type_signature(params_node: tree_sitter.Node) -> str:
    """Build a Java-style type signature from Go parameter declarations.

    Go always has types, so this always returns a signature.
    Handles grouped params like ``(a, b int)`` → ``(int,int)``.
    """
    types: list[str] = []
    for child in params_node.children:
        if child.type == "parameter_declaration":
            type_node = child.child_by_field_name("type")
            if not type_node:
                continue
            type_name = _normalize_go_type(type_node)
            # Count how many names share this type (e.g. `a, b int` → 2 params)
            name_count = sum(1 for sub in child.children if sub.type == "identifier")
            count = name_count if name_count > 0 else 1
            types.extend([type_name] * count)
        elif child.type == "variadic_parameter_declaration":
            type_node = child.child_by_field_name("type")
            if type_node:
                types.append(_normalize_go_type(type_node) + "...")
    return f"({','.join(types)})"


def _normalize_go_type(type_node: tree_sitter.Node) -> str:
    """Normalize a Go type node to a clean Java-style type name."""
    if type_node.type == "pointer_type":
        for sub in type_node.children:
            if sub.type in ("type_identifier", "qualified_type", "pointer_type", "slice_type"):
                return _normalize_go_type(sub)
    if type_node.type == "slice_type":
        elem = type_node.child_by_field_name("element")
        if elem:
            return _normalize_go_type(elem) + "[]"
    if type_node.type == "qualified_type":
        name_node = type_node.child_by_field_name("name")
        if name_node:
            return name_node.text.decode()
    return type_node.text.decode()


def _extract_go_return_type(node: tree_sitter.Node) -> str | None:
    """Extract the return type from a Go function/method declaration.

    Handles single returns (``string``) and multiple returns (``(string, error)``).
    Returns None for void functions.
    """
    result_node = node.child_by_field_name("result")
    if result_node is None:
        return None

    # Single return type
    if result_node.type != "parameter_list":
        return _normalize_go_type(result_node)

    # Multiple return types: (string, error)
    types: list[str] = []
    for child in result_node.children:
        if child.type == "parameter_declaration":
            type_node = child.child_by_field_name("type")
            if type_node:
                types.append(_normalize_go_type(type_node))
        elif child.is_named:
            types.append(_normalize_go_type(child))
    if not types:
        return None
    if len(types) == 1:
        return types[0]
    return f"({','.join(types)})"


def _extract_embedded_structs(struct_node: tree_sitter.Node) -> list[str] | None:
    """Extract embedded (anonymous) field types from a struct_type node."""
    names: list[str] = []
    for child in struct_node.children:
        if child.type == "field_declaration_list":
            for field in child.children:
                if field.type == "field_declaration":
                    # Embedded field: has type but no name
                    name_node = field.child_by_field_name("name")
                    type_node = field.child_by_field_name("type")
                    if type_node and not name_node:
                        # Could be pointer type *Foo or plain Foo
                        if type_node.type == "pointer_type":
                            for sub in type_node.children:
                                if sub.type == "type_identifier":
                                    names.append(sub.text.decode())
                                    break
                        elif type_node.type == "type_identifier":
                            names.append(type_node.text.decode())
                        elif type_node.type == "qualified_type":
                            names.append(type_node.text.decode())
    return names if names else None


def _extract_embedded_interfaces(interface_node: tree_sitter.Node) -> list[str] | None:
    """Extract embedded interface type names from an interface_type node."""
    names: list[str] = []
    for child in interface_node.children:
        # Embedded interfaces appear as type_elem > type_identifier or
        # as direct type_identifier children (depending on Go grammar version)
        if child.type == "type_elem":
            for sub in child.children:
                if sub.type == "type_identifier":
                    names.append(sub.text.decode())
        elif child.type == "type_identifier":
            names.append(child.text.decode())
        elif child.type == "qualified_type":
            names.append(child.text.decode())
    return names if names else None


def _extract_godoc(node: tree_sitter.Node) -> str | None:
    """Extract GoDoc comment from consecutive // comment lines above a node."""
    lines: list[str] = []
    sibling = node.prev_named_sibling
    while sibling is not None and sibling.type == "comment":
        text = sibling.text.decode()
        if text.startswith("//"):
            lines.append(text[2:].strip())
            sibling = sibling.prev_named_sibling
        else:
            break
    if not lines:
        return None
    lines.reverse()
    return "\n".join(lines)


def _collect_calls(node: tree_sitter.Node) -> list[CallRef]:
    """Collect function/method call references from a tree-sitter subtree.

    Captures both bare identifier calls (``foo()``) and selector calls
    (``fmt.Println()``, ``s.Listen()``).
    """
    calls: list[CallRef] = []
    for child in node.children:
        if child.type == "call_expression":
            func_node = child.child_by_field_name("function")
            if func_node and func_node.type == "identifier":
                calls.append(CallRef(name=func_node.text.decode()))
            elif func_node and func_node.type == "selector_expression":
                operand = func_node.child_by_field_name("operand")
                field = func_node.child_by_field_name("field")
                if operand and field:
                    calls.append(
                        CallRef(
                            name=field.text.decode(),
                            receiver=operand.text.decode(),
                            kind="attribute",
                        )
                    )
        calls.extend(_collect_calls(child))
    return calls
