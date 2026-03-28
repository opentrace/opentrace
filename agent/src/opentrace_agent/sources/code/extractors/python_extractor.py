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

"""Python symbol extractor using tree-sitter."""

from __future__ import annotations

from typing import ClassVar

import tree_sitter
import tree_sitter_python

from opentrace_agent.sources.code.extractors.base import (
    CallRef,
    CodeSymbol,
    DerivationRef,
    ExtractionResult,
    SymbolExtractor,
    VariableSymbol,
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
    variables = _extract_class_fields(node)
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="class",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        children=children,
        variables=variables,
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
    variables = _extract_parameters(params_node) if params_node else []
    if body_node:
        variables.extend(_collect_variables(body_node))
    return CodeSymbol(
        name=name_node.text.decode(),
        kind="function",
        start_line=node.start_point.row + 1,
        end_line=node.end_point.row + 1,
        signature=signature,
        calls=calls,
        variables=variables,
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


def _collect_call_args(call_node: tree_sitter.Node) -> list[str]:
    """Extract variable names passed as arguments to a call.

    Only captures simple identifier arguments — skips literals, expressions,
    and nested calls.
    """
    args_node = call_node.child_by_field_name("arguments")
    if not args_node:
        return []
    arg_names: list[str] = []
    for child in args_node.children:
        if child.type == "identifier":
            arg_names.append(child.text.decode())
        elif child.type == "keyword_argument":
            # keyword_argument: name = value — capture value if it's an identifier
            value_node = child.child_by_field_name("value")
            if value_node and value_node.type == "identifier":
                arg_names.append(value_node.text.decode())
    return arg_names


def _collect_calls(node: tree_sitter.Node) -> list[CallRef]:
    """Collect function/method call references from a tree-sitter subtree.

    Captures both bare identifier calls (``foo()``) and attribute calls
    (``self.foo()``, ``mod.func()``).
    """
    calls: list[CallRef] = []
    for child in node.children:
        if child.type == "call":
            func_node = child.child_by_field_name("function")
            call_args = _collect_call_args(child)
            if func_node and func_node.type == "identifier":
                calls.append(CallRef(name=func_node.text.decode(), args=call_args))
            elif func_node and func_node.type == "attribute":
                obj_node = func_node.child_by_field_name("object")
                attr_node = func_node.child_by_field_name("attribute")
                if obj_node and attr_node:
                    calls.append(
                        CallRef(
                            name=attr_node.text.decode(),
                            receiver=obj_node.text.decode(),
                            kind="attribute",
                            args=call_args,
                        )
                    )
        calls.extend(_collect_calls(child))
    return calls


def _extract_parameters(params_node: tree_sitter.Node) -> list[VariableSymbol]:
    """Extract function parameters as VariableSymbol instances.

    Skips ``self`` and ``cls`` parameters.
    """
    variables: list[VariableSymbol] = []
    for child in params_node.children:
        name_text: str | None = None
        type_text: str | None = None
        line = child.start_point.row + 1

        if child.type == "identifier":
            name_text = child.text.decode()
        elif child.type == "default_parameter":
            name_node = child.child_by_field_name("name")
            if name_node:
                name_text = name_node.text.decode()
        elif child.type == "typed_parameter":
            for sub in child.children:
                if sub.type == "identifier" and name_text is None:
                    name_text = sub.text.decode()
            type_node = child.child_by_field_name("type")
            if type_node:
                type_text = type_node.text.decode()
        elif child.type == "typed_default_parameter":
            for sub in child.children:
                if sub.type == "identifier" and name_text is None:
                    name_text = sub.text.decode()
            type_node = child.child_by_field_name("type")
            if type_node:
                type_text = type_node.text.decode()

        if name_text and name_text not in ("self", "cls"):
            variables.append(
                VariableSymbol(
                    name=name_text,
                    kind="parameter",
                    start_line=line,
                    end_line=line,
                    type_annotation=type_text,
                )
            )
    return variables


def _extract_class_fields(node: tree_sitter.Node) -> list[VariableSymbol]:
    """Extract class-level fields from a class definition.

    Captures two patterns:
    1. Class body annotations: ``name: str = "default"`` (dataclass-style)
    2. ``self.x = ...`` assignments in ``__init__`` body
    """
    body = node.child_by_field_name("body")
    if not body:
        return []

    variables: list[VariableSymbol] = []
    seen: set[str] = set()

    for child in body.children:
        # Pattern 1: class-level type-annotated fields (dataclass fields)
        #   name: str           → expression_statement > assignment(identifier, :, type)
        #   name: str = "default" → expression_statement > assignment(identifier, :, type, =, value)
        if child.type == "expression_statement" and child.children:
            expr = child.children[0]
            if expr.type == "assignment":
                _extract_annotated_field(expr, variables, seen)

        # Pattern 2: self.x = ... in __init__
        if child.type == "function_definition":
            fname_node = child.child_by_field_name("name")
            if fname_node and fname_node.text.decode() == "__init__":
                init_body = child.child_by_field_name("body")
                if init_body:
                    _extract_self_assignments(init_body, variables, seen)
        elif child.type == "decorated_definition":
            for sub in child.children:
                if sub.type == "function_definition":
                    fname_node = sub.child_by_field_name("name")
                    if fname_node and fname_node.text.decode() == "__init__":
                        init_body = sub.child_by_field_name("body")
                        if init_body:
                            _extract_self_assignments(init_body, variables, seen)

    return variables


def _extract_annotated_field(
    node: tree_sitter.Node,
    variables: list[VariableSymbol],
    seen: set[str],
) -> None:
    """Extract a class-level annotated field (e.g. ``name: str`` or ``name: str = 'default'``).

    In tree-sitter-python, ``name: str`` parses as::

        assignment
          identifier "name"
          : ":"
          type
            identifier "str"

    And ``name: str = "default"`` also parses as an assignment with a ``right`` field.
    """
    if node.type != "assignment":
        return

    # Find the identifier (field name) — first child that's an identifier
    name_node = None
    type_text = None
    for child in node.children:
        if child.type == "identifier" and name_node is None:
            name_node = child
        elif child.type == "type":
            type_text = child.text.decode()

    # Skip self.x = ... patterns (those are handled separately)
    left = node.child_by_field_name("left")
    if left and left.type == "attribute":
        return

    if name_node and type_text:
        name = name_node.text.decode()
        if name not in seen:
            seen.add(name)
            variables.append(
                VariableSymbol(
                    name=name,
                    kind="field",
                    start_line=node.start_point.row + 1,
                    end_line=node.end_point.row + 1,
                    type_annotation=type_text,
                )
            )


def _extract_self_assignments(
    body_node: tree_sitter.Node,
    variables: list[VariableSymbol],
    seen: set[str],
) -> None:
    """Extract ``self.x = value`` assignments from an __init__ body."""
    for child in body_node.children:
        if child.type == "expression_statement" and child.children:
            expr = child.children[0]
            if expr.type == "assignment":
                left = expr.child_by_field_name("left")
                right = expr.child_by_field_name("right")
                if left and left.type == "attribute":
                    obj = left.child_by_field_name("object")
                    attr = left.child_by_field_name("attribute")
                    if obj and obj.text.decode() == "self" and attr:
                        field_name = attr.text.decode()
                        if field_name not in seen:
                            seen.add(field_name)
                            derived = _derivation_from_expr(right) if right else []
                            variables.append(
                                VariableSymbol(
                                    name=field_name,
                                    kind="field",
                                    start_line=child.start_point.row + 1,
                                    end_line=child.end_point.row + 1,
                                    derived_from=derived,
                                )
                            )


def _derivation_from_expr(node: tree_sitter.Node) -> list[DerivationRef]:
    """Determine what a variable's value is derived from based on the RHS expression.

    Handles:
    - Simple identifier: ``x = y`` → derived from variable y
    - Attribute access: ``x = self.name`` → derived from variable name (receiver=self)
    - Function call: ``x = foo(y)`` → derived from call foo
    - Method call: ``x = obj.method()`` → derived from call method (receiver=obj)
    """
    if node.type == "identifier":
        return [DerivationRef(kind="variable", name=node.text.decode())]
    elif node.type == "attribute":
        obj = node.child_by_field_name("object")
        attr = node.child_by_field_name("attribute")
        if obj and attr:
            return [
                DerivationRef(
                    kind="variable",
                    name=attr.text.decode(),
                    receiver=obj.text.decode(),
                )
            ]
    elif node.type == "call":
        func_node = node.child_by_field_name("function")
        if func_node and func_node.type == "identifier":
            return [DerivationRef(kind="call", name=func_node.text.decode())]
        elif func_node and func_node.type == "attribute":
            obj = func_node.child_by_field_name("object")
            attr = func_node.child_by_field_name("attribute")
            if obj and attr:
                return [
                    DerivationRef(
                        kind="call",
                        name=attr.text.decode(),
                        receiver=obj.text.decode(),
                    )
                ]
    return []


def _collect_variables(body_node: tree_sitter.Node) -> list[VariableSymbol]:
    """Collect local variable assignments from a function body.

    Extracts top-level assignments in the body (not nested in control flow)
    as well as simple assignments inside if/for/while/try blocks.
    """
    variables: list[VariableSymbol] = []
    seen: set[str] = set()
    _walk_body_for_variables(body_node, variables, seen)
    return variables


def _walk_body_for_variables(
    node: tree_sitter.Node,
    variables: list[VariableSymbol],
    seen: set[str],
) -> None:
    """Recursively walk a body node collecting variable assignments."""
    for child in node.children:
        if child.type == "expression_statement" and child.children:
            expr = child.children[0]
            if expr.type == "assignment":
                _extract_local_assignment(expr, variables, seen)
        # Walk into blocks (if, for, while, try, with)
        elif child.type in (
            "if_statement", "for_statement", "while_statement",
            "try_statement", "with_statement", "elif_clause",
            "else_clause", "except_clause", "finally_clause",
            "block",
        ):
            body = child.child_by_field_name("body") or child.child_by_field_name("consequence")
            if body:
                _walk_body_for_variables(body, variables, seen)
            # Also walk alternative/else branches
            alternative = child.child_by_field_name("alternative")
            if alternative:
                _walk_body_for_variables(alternative, variables, seen)
            # Walk child clauses (elif, except, else, finally)
            for sub in child.children:
                if sub.type in ("elif_clause", "else_clause", "except_clause", "finally_clause"):
                    _walk_body_for_variables(sub, variables, seen)


def _extract_local_assignment(
    node: tree_sitter.Node,
    variables: list[VariableSymbol],
    seen: set[str],
) -> None:
    """Extract a local variable from an assignment node.

    Handles:
    - ``x = expr``
    - ``x: type = expr`` (annotated assignment)
    """
    left = node.child_by_field_name("left")
    right = node.child_by_field_name("right")
    if not left:
        return

    name_text: str | None = None
    type_text: str | None = None

    if left.type == "identifier":
        name_text = left.text.decode()
    elif left.type == "type":
        # Annotated assignment: `x: int = ...`
        for sub in left.children:
            if sub.type == "identifier":
                name_text = sub.text.decode()
                break
        # Last child after ":" is the type
        if len(left.children) > 1:
            type_text = left.children[-1].text.decode()

    # Skip self.x assignments (handled by _extract_self_assignments)
    if left.type == "attribute":
        return

    if name_text and name_text not in seen:
        seen.add(name_text)
        derived = _derivation_from_expr(right) if right else []
        variables.append(
            VariableSymbol(
                name=name_text,
                kind="local",
                start_line=node.start_point.row + 1,
                end_line=node.end_point.row + 1,
                type_annotation=type_text,
                derived_from=derived,
            )
        )
