"""Python symbol extractor using tree-sitter."""

from __future__ import annotations

from typing import ClassVar

import tree_sitter
import tree_sitter_python

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
        lang = tree_sitter.Language(tree_sitter_python.language())
        _PARSER = tree_sitter.Parser(lang)
    return _PARSER


class PythonExtractor(SymbolExtractor):
    """Extracts class and function symbols from Python source files."""

    extensions: ClassVar[tuple[str, ...]] = (".py",)
    language_name: ClassVar[str] = "python"

    def extract(self, source_bytes: bytes) -> ExtractionResult:
        parser = _get_parser()
        tree = parser.parse(source_bytes)
        symbols = _walk_node(tree.root_node)
        return ExtractionResult(symbols=symbols, language=self.language_name, root_node=tree.root_node)


def _walk_node(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Walk a tree-sitter node and extract class/function symbols."""
    symbols: list[CodeSymbol] = []
    for child in node.children:
        if child.type == "class_definition":
            sym = _extract_class(child)
            if sym:
                symbols.append(sym)
        elif child.type == "function_definition":
            sym = _extract_function(child)
            if sym:
                symbols.append(sym)
        elif child.type == "decorated_definition":
            # Unwrap decorated definitions to find the actual class/function
            for sub in child.children:
                if sub.type == "class_definition":
                    sym = _extract_class(sub)
                    if sym:
                        symbols.append(sym)
                elif sub.type == "function_definition":
                    sym = _extract_function(sub)
                    if sym:
                        symbols.append(sym)
    return symbols


def _extract_class(node: tree_sitter.Node) -> CodeSymbol | None:
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    children = _walk_class_body(node)
    superclasses = _extract_superclasses(node)
    docs = _extract_docstring(node)
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="class",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        children=children,
        superclasses=superclasses,
        docs=docs,
    )


def _walk_class_body(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Extract methods from a class body."""
    body = node.child_by_field_name("body")
    if not body:
        return []
    methods: list[CodeSymbol] = []
    for child in body.children:
        if child.type == "function_definition":
            sym = _extract_function(child)
            if sym:
                methods.append(sym)
        elif child.type == "decorated_definition":
            for sub in child.children:
                if sub.type == "function_definition":
                    sym = _extract_function(sub)
                    if sym:
                        methods.append(sym)
    return methods


def _extract_function(node: tree_sitter.Node) -> CodeSymbol | None:
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    params_node = node.child_by_field_name("parameters")
    signature = params_node.text.decode() if params_node else None
    param_types = _extract_param_types(params_node) if params_node else None
    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    docs = _extract_docstring(node)
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
        param_types=param_types,
        docs=docs,
    )


def _extract_param_types(params_node: tree_sitter.Node) -> dict[str, str] | None:
    """Extract parameter name → type name mapping from type annotations.

    Takes the leaf of dotted types (e.g., ``grpc.Channel`` → ``Channel``).
    Skips ``self`` and ``cls`` parameters.
    """
    types: dict[str, str] = {}
    for child in params_node.children:
        if child.type in ("typed_parameter", "typed_default_parameter"):
            # Name is the first identifier child (no "name" field in Python grammar)
            name_node = None
            for sub in child.children:
                if sub.type == "identifier":
                    name_node = sub
                    break
            type_node = child.child_by_field_name("type")
            if name_node and type_node:
                param_name = name_node.text.decode()
                if param_name in ("self", "cls"):
                    continue
                type_text = type_node.text.decode()
                # Take the leaf of dotted types
                leaf = type_text.rsplit(".", 1)[-1] if "." in type_text else type_text
                types[param_name] = leaf
    return types if types else None


def _extract_superclasses(node: tree_sitter.Node) -> list[str] | None:
    """Extract base class names from a class definition's argument_list."""
    superclasses_node = node.child_by_field_name("superclasses")
    if superclasses_node is None:
        return None
    names: list[str] = []
    for child in superclasses_node.children:
        if child.type == "identifier":
            names.append(child.text.decode())
        elif child.type == "attribute":
            # e.g. module.ClassName — take the full dotted name
            names.append(child.text.decode())
    return names if names else None


def _extract_docstring(node: tree_sitter.Node) -> str | None:
    """Extract a docstring from the first statement of a class/function body."""
    body = node.child_by_field_name("body")
    if body is None or not body.children:
        return None
    first = body.children[0]
    if first.type == "expression_statement" and first.children:
        string_node = first.children[0]
        if string_node.type == "string":
            text = string_node.text.decode()
            # Strip triple-quote delimiters
            for delim in ('"""', "'''"):
                if text.startswith(delim) and text.endswith(delim):
                    return text[3:-3].strip()
            # Strip single-quote delimiters
            for delim in ('"', "'"):
                if text.startswith(delim) and text.endswith(delim):
                    return text[1:-1].strip()
            return text
    return None


def _collect_calls(node: tree_sitter.Node) -> list[CallRef]:
    """Collect function/method call references from a tree-sitter subtree.

    Captures both bare identifier calls (``foo()``) and attribute calls
    (``self.foo()``, ``mod.func()``).
    """
    calls: list[CallRef] = []
    for child in node.children:
        if child.type == "call":
            func_node = child.child_by_field_name("function")
            if func_node and func_node.type == "identifier":
                calls.append(CallRef(name=func_node.text.decode()))
            elif func_node and func_node.type == "attribute":
                obj_node = func_node.child_by_field_name("object")
                attr_node = func_node.child_by_field_name("attribute")
                if obj_node and attr_node:
                    calls.append(
                        CallRef(
                            name=attr_node.text.decode(),
                            receiver=obj_node.text.decode(),
                            kind="attribute",
                        )
                    )
        calls.extend(_collect_calls(child))
    return calls
