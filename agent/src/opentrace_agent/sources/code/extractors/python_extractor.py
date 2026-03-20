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
    CallArg,
    CallRef,
    CodeSymbol,
    ExtractionResult,
    SymbolExtractor,
    VariableRef,
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
    variables = _collect_variables(body_node) if body_node else []
    docs = _extract_docstring(node)
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


def _collect_calls(node: tree_sitter.Node) -> list[CallRef]:
    """Collect function/method call references from a tree-sitter subtree.

    Captures both bare identifier calls (``foo()``) and attribute calls
    (``self.foo()``, ``mod.func()``).  Each call also records its arguments
    so we can trace which variables flow into each call site.
    """
    calls: list[CallRef] = []
    for child in node.children:
        if child.type == "call":
            func_node = child.child_by_field_name("function")
            arguments = _extract_call_arguments(child)
            if func_node and func_node.type == "identifier":
                calls.append(CallRef(name=func_node.text.decode(), arguments=arguments))
            elif func_node and func_node.type == "attribute":
                obj_node = func_node.child_by_field_name("object")
                attr_node = func_node.child_by_field_name("attribute")
                if obj_node and attr_node:
                    calls.append(
                        CallRef(
                            name=attr_node.text.decode(),
                            receiver=obj_node.text.decode(),
                            kind="attribute",
                            arguments=arguments,
                        )
                    )
        calls.extend(_collect_calls(child))
    return calls


def _extract_call_arguments(call_node: tree_sitter.Node) -> list[CallArg]:
    """Extract arguments from a call node's argument_list."""
    args_node = call_node.child_by_field_name("arguments")
    if args_node is None:
        return []
    arguments: list[CallArg] = []
    for child in args_node.children:
        if child.type in (",", "(", ")"):
            continue
        if child.type == "identifier":
            arguments.append(CallArg(name=child.text.decode(), kind="variable"))
        elif child.type == "keyword_argument":
            # e.g. key=value — capture the value side
            value_node = child.child_by_field_name("value")
            if value_node and value_node.type == "identifier":
                arguments.append(CallArg(name=value_node.text.decode(), kind="variable"))
            elif value_node:
                arguments.append(CallArg(name=value_node.text.decode(), kind=_classify_arg(value_node)))
        elif child.type == "call":
            arguments.append(CallArg(name=child.text.decode(), kind="call"))
        elif child.type == "attribute":
            arguments.append(CallArg(name=child.text.decode(), kind="variable"))
        elif child.type in ("string", "integer", "float", "true", "false", "none"):
            arguments.append(CallArg(name=child.text.decode(), kind="literal"))
        else:
            arguments.append(CallArg(name=child.text.decode(), kind=_classify_arg(child)))
    return arguments


def _classify_arg(node: tree_sitter.Node) -> str:
    """Classify an argument node into a CallArg kind."""
    if node.type in ("string", "integer", "float", "true", "false", "none"):
        return "literal"
    if node.type == "call":
        return "call"
    if node.type in ("identifier", "attribute"):
        return "variable"
    return "other"


def _collect_variables(node: tree_sitter.Node) -> list[VariableRef]:
    """Collect variable assignments from a function/class body.

    Handles:
      - Simple assignments: ``x = ...``
      - Annotated assignments: ``x: int = ...``
      - Augmented assignments: ``x += ...``
      - Multiple targets: ``a, b = ...`` (tuple unpacking)
      - For-loop targets: ``for x in ...``
      - With-statement targets: ``with open(...) as f``
    """
    variables: list[VariableRef] = []
    _walk_for_variables(node, variables)
    return variables


def _walk_for_variables(node: tree_sitter.Node, variables: list[VariableRef]) -> None:
    """Recursively walk nodes to find variable assignments."""
    for child in node.children:
        if child.type == "assignment":
            _extract_assignment_targets(child, variables)
        elif child.type == "augmented_assignment":
            left = child.child_by_field_name("left")
            if left and left.type == "identifier":
                variables.append(VariableRef(
                    name=left.text.decode(),
                    line=child.start_point.row + 1,
                ))
        elif child.type == "type_alias_statement":
            # type X = ... — skip type aliases
            pass
        elif child.type == "expression_statement":
            # Check for assignments inside expression statements
            for sub in child.children:
                if sub.type == "assignment":
                    _extract_assignment_targets(sub, variables)
                elif sub.type == "augmented_assignment":
                    left = sub.child_by_field_name("left")
                    if left and left.type == "identifier":
                        variables.append(VariableRef(
                            name=left.text.decode(),
                            line=sub.start_point.row + 1,
                        ))
        elif child.type == "for_statement":
            left = child.child_by_field_name("left")
            if left:
                _extract_pattern_names(left, child.start_point.row + 1, variables)
            # Walk the body for nested assignments
            body = child.child_by_field_name("body")
            if body:
                _walk_for_variables(body, variables)
        elif child.type == "with_statement":
            # with expr as name — extract name
            for sub in child.children:
                if sub.type == "with_clause":
                    for item in sub.children:
                        if item.type == "with_item":
                            alias_node = item.child_by_field_name("alias") or _find_child_by_type(item, "as_pattern")
                            if alias_node:
                                _extract_pattern_names(alias_node, child.start_point.row + 1, variables)
            body = child.child_by_field_name("body")
            if body:
                _walk_for_variables(body, variables)
        elif child.type in ("if_statement", "while_statement", "try_statement", "elif_clause", "else_clause"):
            # Walk into compound statement bodies
            _walk_for_variables(child, variables)
        elif child.type == "block":
            _walk_for_variables(child, variables)

    # Also check for standalone annotated assignments (type: x: int = ...)
    if node.type == "block":
        for child in node.children:
            if child.type == "type" and child.parent and child.parent.type == "assignment":
                continue  # handled above


def _extract_assignment_targets(
    assign_node: tree_sitter.Node,
    variables: list[VariableRef],
) -> None:
    """Extract variable names from the left side of an assignment."""
    left = assign_node.child_by_field_name("left")
    if left is None:
        return
    line = assign_node.start_point.row + 1

    # Check for type annotation
    type_node = assign_node.child_by_field_name("type")
    type_ann = type_node.text.decode() if type_node else None

    _extract_pattern_names(left, line, variables, type_ann)


def _extract_pattern_names(
    node: tree_sitter.Node,
    line: int,
    variables: list[VariableRef],
    type_annotation: str | None = None,
) -> None:
    """Extract names from assignment patterns (identifier, tuple, list)."""
    if node.type == "identifier":
        name = node.text.decode()
        if name not in ("_", "self", "cls"):
            variables.append(VariableRef(name=name, line=line, type_annotation=type_annotation))
    elif node.type in ("pattern_list", "tuple_pattern", "list_pattern"):
        for child in node.children:
            if child.type not in (",", "(", ")", "[", "]"):
                _extract_pattern_names(child, line, variables)
    elif node.type == "attribute":
        # self.x = ... — capture as "self.x"
        variables.append(VariableRef(name=node.text.decode(), line=line, type_annotation=type_annotation))


def _find_child_by_type(node: tree_sitter.Node, type_name: str) -> tree_sitter.Node | None:
    """Find a direct child node by its type."""
    for child in node.children:
        if child.type == type_name:
            return child
    return None
