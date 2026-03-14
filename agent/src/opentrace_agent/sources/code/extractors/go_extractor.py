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
        return ExtractionResult(
            symbols=symbols, language=self.language_name, root_node=tree.root_node
        )


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
                methods = (
                    _extract_struct_methods(type_node)
                    if type_node.type == "interface_type"
                    else []
                )
                return CodeSymbol(
                    name=name_node.text.decode(),
                    kind="class",
                    start_line=node.start_point.row + 1,
                    end_line=node.end_point.row + 1,
                    children=methods,
                )
    return None


def _extract_struct_methods(node: tree_sitter.Node) -> list[CodeSymbol]:
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
    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
    )


def _extract_method(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract a method declaration (func (receiver) Name(...) ...)."""
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    params_node = node.child_by_field_name("parameters")
    receiver_node = node.child_by_field_name("receiver")
    # Build signature including receiver
    parts: list[str] = []
    receiver_var: str | None = None
    receiver_type: str | None = None
    if receiver_node:
        parts.append(receiver_node.text.decode())
        receiver_var, receiver_type = _parse_receiver(receiver_node)
    if params_node:
        parts.append(params_node.text.decode())
    signature = " ".join(parts) if parts else None
    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
        receiver_var=receiver_var,
        receiver_type=receiver_type,
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
