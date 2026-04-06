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

"""TypeScript/TSX symbol extractor using tree-sitter."""

from __future__ import annotations

from typing import ClassVar

import tree_sitter
import tree_sitter_typescript

from opentrace_agent.sources.code.extractors.base import (
    CallRef,
    CodeSymbol,
    ExtractionResult,
    SymbolExtractor,
)

_TS_PARSER: tree_sitter.Parser | None = None
_TSX_PARSER: tree_sitter.Parser | None = None


def _get_ts_parser() -> tree_sitter.Parser:
    global _TS_PARSER
    if _TS_PARSER is None:
        lang = tree_sitter.Language(tree_sitter_typescript.language_typescript())
        _TS_PARSER = tree_sitter.Parser(lang)
    return _TS_PARSER


def _get_tsx_parser() -> tree_sitter.Parser:
    global _TSX_PARSER
    if _TSX_PARSER is None:
        lang = tree_sitter.Language(tree_sitter_typescript.language_tsx())
        _TSX_PARSER = tree_sitter.Parser(lang)
    return _TSX_PARSER


class TypeScriptExtractor(SymbolExtractor):
    """Extracts class and function symbols from TypeScript/TSX source files."""

    extensions: ClassVar[tuple[str, ...]] = (".ts", ".tsx", ".js", ".jsx")
    language_name: ClassVar[str] = "typescript"

    def extract(self, source_bytes: bytes, *, tsx: bool | None = None) -> ExtractionResult:
        if tsx is None:
            # Default: can't infer from bytes alone, use TS parser
            # The caller (SymbolAttacher) should set tsx based on extension
            tsx = False
        parser = _get_tsx_parser() if tsx else _get_ts_parser()
        tree = parser.parse(source_bytes)
        symbols = _walk_node(tree.root_node)
        return ExtractionResult(symbols=symbols, language=self.language_name, root_node=tree.root_node)

    def extract_for_extension(self, source_bytes: bytes, extension: str) -> ExtractionResult:
        """Extract with the correct parser based on file extension."""
        # TSX parser handles JSX syntax and is also a superset of plain JS
        tsx = extension in (".tsx", ".jsx")
        language = "javascript" if extension in (".js", ".jsx") else "typescript"
        result = self.extract(source_bytes, tsx=tsx)
        return ExtractionResult(symbols=result.symbols, language=language, root_node=result.root_node)


_CLASS_TYPES = {"class_declaration", "abstract_class_declaration"}
_FUNCTION_TYPES = {"function_declaration"}
_METHOD_TYPES = {"method_definition", "public_field_definition"}


def _walk_node(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Walk a tree-sitter node and extract class/function symbols."""
    symbols: list[CodeSymbol] = []
    for child in node.children:
        if child.type in _CLASS_TYPES:
            sym = _extract_class(child)
            if sym:
                symbols.append(sym)
        elif child.type in _FUNCTION_TYPES:
            sym = _extract_function(child)
            if sym:
                symbols.append(sym)
        elif child.type == "lexical_declaration":
            symbols.extend(_extract_lexical_declaration(child))
        elif child.type == "export_statement":
            # Unwrap `export class ...` / `export function ...`
            symbols.extend(_walk_node(child))
    return symbols


def _extract_class(node: tree_sitter.Node) -> CodeSymbol | None:
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    children = _walk_class_body(node)
    superclasses, interfaces = _extract_heritage(node)
    docs = _extract_jsdoc(node)
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="class",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        children=children,
        superclasses=superclasses,
        interfaces=interfaces,
        docs=docs,
    )


def _walk_class_body(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Extract methods from a class body."""
    body = node.child_by_field_name("body")
    if not body:
        return []
    methods: list[CodeSymbol] = []
    for child in body.children:
        if child.type in _METHOD_TYPES:
            sym = _extract_method(child)
            if sym:
                methods.append(sym)
    return methods


def _extract_function(node: tree_sitter.Node) -> CodeSymbol | None:
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    params_node = node.child_by_field_name("parameters")
    signature = params_node.text.decode() if params_node else None
    type_signature = _extract_ts_type_signature(params_node) if params_node else None
    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    docs = _extract_jsdoc(node)
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


def _extract_method(node: tree_sitter.Node) -> CodeSymbol | None:
    name_node = node.child_by_field_name("name")
    if not name_node:
        return None
    params_node = node.child_by_field_name("parameters")
    signature = params_node.text.decode() if params_node else None
    type_signature = _extract_ts_type_signature(params_node) if params_node else None
    return_type = _extract_return_type(node)
    body_node = node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
        type_signature=type_signature,
        return_type=return_type,
    )


def _extract_lexical_declaration(node: tree_sitter.Node) -> list[CodeSymbol]:
    """Extract symbols from ``const foo = () => {}`` / ``const Foo = class {}``."""
    symbols: list[CodeSymbol] = []
    for child in node.children:
        if child.type == "variable_declarator":
            name_node = child.child_by_field_name("name")
            value_node = child.child_by_field_name("value")
            if not name_node or not value_node:
                continue
            name = name_node.text.decode()
            if value_node.type in ("arrow_function", "function_expression"):
                sym = _extract_arrow_function(name, node, value_node)
                if sym:
                    symbols.append(sym)
            elif value_node.type == "class":
                sym = _extract_class_expression(name, node, value_node)
                if sym:
                    symbols.append(sym)
    return symbols


def _extract_arrow_function(
    name: str,
    decl_node: tree_sitter.Node,
    value_node: tree_sitter.Node,
) -> CodeSymbol:
    """Extract a function symbol from an arrow function or function expression."""
    params_node = value_node.child_by_field_name("parameters")
    signature = params_node.text.decode() if params_node else None
    type_signature = _extract_ts_type_signature(params_node) if params_node else None
    return_type = _extract_return_type(value_node)
    body_node = value_node.child_by_field_name("body")
    calls = _collect_calls(body_node) if body_node else []
    return CodeSymbol(
        name=name,
        kind="function",
        start_line=decl_node.start_point.row + 1,
        end_line=decl_node.end_point.row + 1,
        signature=signature,
        calls=calls,
        type_signature=type_signature,
        return_type=return_type,
    )


def _extract_class_expression(
    name: str,
    decl_node: tree_sitter.Node,
    value_node: tree_sitter.Node,
) -> CodeSymbol:
    """Extract a class symbol from ``const Foo = class { ... }``."""
    children = _walk_class_body(value_node)
    return CodeSymbol(
        name=name,
        kind="class",
        start_line=decl_node.start_point.row + 1,
        end_line=decl_node.end_point.row + 1,
        children=children,
    )


def _extract_heritage(
    node: tree_sitter.Node,
) -> tuple[list[str] | None, list[str] | None]:
    """Extract extends/implements from a class_heritage node."""
    superclasses: list[str] = []
    interfaces: list[str] = []
    for child in node.children:
        if child.type == "class_heritage":
            for clause in child.children:
                if clause.type == "extends_clause":
                    for sub in clause.children:
                        if sub.type == "identifier":
                            superclasses.append(sub.text.decode())
                        elif sub.type == "member_expression":
                            superclasses.append(sub.text.decode())
                elif clause.type == "implements_clause":
                    for sub in clause.children:
                        if sub.type == "identifier":
                            interfaces.append(sub.text.decode())
                        elif sub.type == "member_expression":
                            interfaces.append(sub.text.decode())
                        elif sub.type == "generic_type":
                            # e.g. Iterable<T> — take the base identifier
                            name_node = sub.children[0] if sub.children else None
                            if name_node and name_node.type == "identifier":
                                interfaces.append(name_node.text.decode())
    return (superclasses or None, interfaces or None)


def _extract_return_type(node: tree_sitter.Node) -> str | None:
    """Extract the return type annotation from a TS/JS function node."""
    return_type_node = node.child_by_field_name("return_type")
    if return_type_node is None:
        return None
    raw = return_type_node.text.decode().replace(" ", "")
    return raw.rsplit(".", 1)[-1] if "." in raw else raw


def _extract_ts_type_signature(params_node: tree_sitter.Node) -> str | None:
    """Build a Java-style type signature from TS/JS parameter type annotations.

    Returns ``"()"`` for zero-param functions, ``"(string,number)"`` when all
    params are typed, or ``None`` when any param lacks a type annotation.
    """
    types: list[str] = []
    param_count = 0

    for child in params_node.children:
        if child.type in ("required_parameter", "optional_parameter"):
            param_count += 1
            type_node = child.child_by_field_name("type")
            if type_node:
                raw = type_node.text.decode().replace(" ", "")
                leaf = raw.rsplit(".", 1)[-1] if "." in raw else raw
                types.append(leaf)
        elif child.type == "rest_parameter":
            param_count += 1
            type_node = child.child_by_field_name("type")
            if type_node:
                raw = type_node.text.decode().replace(" ", "")
                leaf = raw.rsplit(".", 1)[-1] if "." in raw else raw
                types.append(leaf + "[]")

    if param_count == 0:
        return "()"
    if len(types) != param_count:
        return None
    return f"({','.join(types)})"


def _extract_jsdoc(node: tree_sitter.Node) -> str | None:
    """Extract a JSDoc comment (/** ... */) from the previous sibling."""
    sibling = node.prev_named_sibling
    if sibling is not None and sibling.type == "comment":
        text = sibling.text.decode()
        if text.startswith("/**") and text.endswith("*/"):
            # Strip /** and */ delimiters, clean up leading * on each line
            inner = text[3:-2]
            lines = []
            for line in inner.split("\n"):
                stripped = line.strip()
                if stripped.startswith("*"):
                    stripped = stripped[1:].strip()
                lines.append(stripped)
            return "\n".join(lines).strip()
    return None


def _collect_calls(node: tree_sitter.Node) -> list[CallRef]:
    """Collect function/method call references from a tree-sitter subtree.

    Captures both bare identifier calls (``foo()``) and member expression calls
    (``this.foo()``, ``console.log()``).
    """
    calls: list[CallRef] = []
    for child in node.children:
        if child.type == "call_expression":
            func_node = child.child_by_field_name("function")
            if func_node and func_node.type == "identifier":
                calls.append(CallRef(name=func_node.text.decode()))
            elif func_node and func_node.type == "member_expression":
                obj_node = func_node.child_by_field_name("object")
                prop_node = func_node.child_by_field_name("property")
                if obj_node and prop_node:
                    calls.append(
                        CallRef(
                            name=prop_node.text.decode(),
                            receiver=obj_node.text.decode(),
                            kind="attribute",
                        )
                    )
        calls.extend(_collect_calls(child))
    return calls
