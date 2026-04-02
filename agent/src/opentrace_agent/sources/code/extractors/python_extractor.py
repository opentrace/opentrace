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
    """Extract identifier names passed as arguments to a call."""
    args: list[str] = []
    args_node = call_node.child_by_field_name("arguments")
    if args_node is None:
        return args
    for child in args_node.children:
        if child.type == "identifier":
            args.append(child.text.decode())
    return args


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


# --- Variable extraction ---


def _extract_parameters(params_node: tree_sitter.Node) -> list[VariableSymbol]:
    """Extract function parameters as VariableSymbol instances.

    Skips ``self`` and ``cls`` parameters.
    """
    variables: list[VariableSymbol] = []
    for child in params_node.children:
        name: str | None = None
        type_ann: str | None = None
        if child.type == "identifier":
            name = child.text.decode()
        elif child.type in ("typed_parameter", "typed_default_parameter"):
            for sub in child.children:
                if sub.type == "identifier" and name is None:
                    name = sub.text.decode()
            type_node = child.child_by_field_name("type")
            if type_node:
                type_ann = type_node.text.decode()
        elif child.type == "default_parameter":
            name_child = child.child_by_field_name("name")
            if name_child:
                name = name_child.text.decode()

        if name and name not in ("self", "cls"):
            line = child.start_point.row + 1
            variables.append(
                VariableSymbol(
                    name=name,
                    kind="parameter",
                    start_line=line,
                    end_line=line,
                    type_annotation=type_ann,
                )
            )
    return variables


def _extract_class_fields(class_node: tree_sitter.Node) -> list[VariableSymbol]:
    """Extract class-level fields from a class definition.

    Handles:
    - Annotated class attributes (dataclass fields): ``name: str = "default"``
    - ``self.x = ...`` assignments in ``__init__``
    """
    variables: list[VariableSymbol] = []
    seen: set[str] = set()
    body = class_node.child_by_field_name("body")
    if body is None:
        return variables

    for child in body.children:
        # Annotated class attributes (e.g., dataclass fields) and plain assignments
        if child.type == "expression_statement" and child.children:
            inner = child.children[0]
            if inner.type == "assignment":
                var = _extract_annotated_field(inner)
                if var and var.name not in seen:
                    seen.add(var.name)
                    variables.append(var)

        # Find __init__ and extract self.x assignments
        func_node = None
        if child.type == "function_definition":
            func_node = child
        elif child.type == "decorated_definition":
            for sub in child.children:
                if sub.type == "function_definition":
                    func_node = sub
                    break

        if func_node is not None:
            name_node = func_node.child_by_field_name("name")
            if name_node and name_node.text.decode() == "__init__":
                init_body = func_node.child_by_field_name("body")
                if init_body:
                    for var in _extract_self_assignments(init_body):
                        if var.name not in seen:
                            seen.add(var.name)
                            variables.append(var)

    return variables


def _extract_annotated_field(assignment_node: tree_sitter.Node) -> VariableSymbol | None:
    """Extract a field from an assignment node (``name: str = "default"``)."""
    left = assignment_node.child_by_field_name("left")
    right = assignment_node.child_by_field_name("right")
    if left is None:
        return None

    if left.type != "identifier":
        return None

    # Type annotation is a separate field on the assignment node
    type_node = assignment_node.child_by_field_name("type")
    type_ann = type_node.text.decode() if type_node else None
    derivation = _derivation_from_expr(right) if right else []
    line = assignment_node.start_point.row + 1
    return VariableSymbol(
        name=left.text.decode(),
        kind="field",
        start_line=line,
        end_line=line,
        type_annotation=type_ann,
        derived_from=derivation,
    )


def _extract_self_assignments(body_node: tree_sitter.Node) -> list[VariableSymbol]:
    """Extract ``self.x = ...`` assignments from a function body.

    Recursively walks into nested blocks (if/else/try/etc.) to catch
    conditional self-assignments, but stops at nested function/class scopes.
    """
    variables: list[VariableSymbol] = []
    _walk_for_self_assignments(body_node, variables)
    return variables


def _walk_for_self_assignments(node: tree_sitter.Node, variables: list[VariableSymbol]) -> None:
    """Recursively collect self.x assignments."""
    for child in node.children:
        if child.type == "expression_statement" and child.children:
            inner = child.children[0]
            if inner.type == "assignment":
                left = inner.child_by_field_name("left")
                right = inner.child_by_field_name("right")
                if left and left.type == "attribute":
                    obj = left.child_by_field_name("object")
                    attr = left.child_by_field_name("attribute")
                    if obj and attr and obj.text.decode() == "self":
                        derivation = _derivation_from_expr(right) if right else []
                        line = inner.start_point.row + 1
                        variables.append(
                            VariableSymbol(
                                name=attr.text.decode(),
                                kind="field",
                                start_line=line,
                                end_line=line,
                                derived_from=derivation,
                            )
                        )
        # Skip nested scopes
        if child.type in _NEW_SCOPE_TYPES or child.type == "decorated_definition":
            continue
        _walk_for_self_assignments(child, variables)


def _derivation_from_expr(expr_node: tree_sitter.Node) -> list[DerivationRef]:
    """Determine derivation references from a right-hand-side expression.

    Handles simple cases (identifier, call, attribute) directly, and
    recursively collects identifiers from compound expressions
    (e.g., ``y + z``, ``[a, b]``, ``f(x) + g(y)``).
    """
    if expr_node.type == "identifier":
        return [DerivationRef(kind="identifier", name=expr_node.text.decode())]
    if expr_node.type == "call":
        func = expr_node.child_by_field_name("function")
        if func and func.type == "identifier":
            return [DerivationRef(kind="call", name=func.text.decode())]
        if func and func.type == "attribute":
            obj = func.child_by_field_name("object")
            attr = func.child_by_field_name("attribute")
            if obj and attr:
                return [DerivationRef(kind="call", name=attr.text.decode(), receiver=obj.text.decode())]
    if expr_node.type == "attribute":
        obj = expr_node.child_by_field_name("object")
        attr = expr_node.child_by_field_name("attribute")
        if obj and attr:
            return [DerivationRef(kind="attribute", name=attr.text.decode(), receiver=obj.text.decode())]
    # Compound expression — recursively collect from all children
    refs: list[DerivationRef] = []
    for child in expr_node.children:
        refs.extend(_derivation_from_expr(child))
    return refs


def _collect_variables(body_node: tree_sitter.Node) -> list[VariableSymbol]:
    """Collect local variable assignments from a function body."""
    variables: list[VariableSymbol] = []
    seen: set[str] = set()
    _walk_body_for_variables(body_node, variables, seen)
    return variables


_NEW_SCOPE_TYPES = frozenset({"class_definition", "function_definition"})


def _walk_body_for_variables(
    node: tree_sitter.Node,
    variables: list[VariableSymbol],
    seen: set[str],
) -> None:
    """Recursively walk a function body for variable assignments.

    Recurses into all children (if/elif/else/for/while/with/try/except/finally
    blocks) but stops at new scopes (nested class or function definitions).
    """
    for child in node.children:
        if child.type == "expression_statement" and child.children:
            inner = child.children[0]
            if inner.type == "assignment":
                var = _extract_local_assignment(inner)
                if var and var.name not in seen:
                    seen.add(var.name)
                    variables.append(var)
        # Skip nested scopes — they define their own variables
        if child.type in _NEW_SCOPE_TYPES:
            continue
        if child.type == "decorated_definition":
            continue
        # Recurse into everything else (blocks, clauses, etc.)
        _walk_body_for_variables(child, variables, seen)


def _extract_local_assignment(assignment_node: tree_sitter.Node) -> VariableSymbol | None:
    """Extract a local variable from an assignment node."""
    left = assignment_node.child_by_field_name("left")
    right = assignment_node.child_by_field_name("right")
    if left is None:
        return None

    # Skip self.x assignments (those are class fields, not locals)
    if left.type == "attribute":
        return None
    if left.type != "identifier":
        return None

    name = left.text.decode()
    if name == "_":
        return None

    # Type annotation is a separate field on the assignment node
    type_node = assignment_node.child_by_field_name("type")
    type_ann = type_node.text.decode() if type_node else None

    derivation = _derivation_from_expr(right) if right else []
    line = assignment_node.start_point.row + 1
    return VariableSymbol(
        name=name,
        kind="local",
        start_line=line,
        end_line=line,
        type_annotation=type_ann,
        derived_from=derivation,
    )
