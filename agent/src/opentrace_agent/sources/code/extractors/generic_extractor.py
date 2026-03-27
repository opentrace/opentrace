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

"""Generic table-driven symbol extractor for languages without bespoke extractors.

Uses per-language configuration tables to identify class-like and function-like
AST node types.  Extracts names, line numbers, and parent-child relationships.

Limitations (acceptable for v1):
  - calls array is always empty (no call extraction)
  - No import analysis (importAnalyzer returns empty for unknown languages)
  - receiverVar/receiverType always None
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import ClassVar

import tree_sitter

from opentrace_agent.sources.code.directory_walker import EXTENSION_LANGUAGE_MAP
from opentrace_agent.sources.code.extractors.base import (
    CodeSymbol,
    ExtractionResult,
    SymbolExtractor,
)


# ---------------------------------------------------------------------------
# Language configuration
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LanguageConfig:
    """Per-language sets of AST node types for class-like, function-like,
    and container (recurse-into) constructs."""

    class_types: frozenset[str]
    function_types: frozenset[str]
    container_types: frozenset[str]


LANGUAGE_CONFIGS: dict[str, LanguageConfig] = {
    "c": LanguageConfig(
        class_types=frozenset({"struct_specifier", "enum_specifier"}),
        function_types=frozenset({"function_definition"}),
        container_types=frozenset(),
    ),
    "cpp": LanguageConfig(
        class_types=frozenset({"class_specifier", "struct_specifier", "enum_specifier"}),
        function_types=frozenset({"function_definition"}),
        container_types=frozenset({"class_specifier", "namespace_definition"}),
    ),
    "csharp": LanguageConfig(
        class_types=frozenset({
            "class_declaration",
            "interface_declaration",
            "struct_declaration",
            "enum_declaration",
        }),
        function_types=frozenset({"method_declaration", "local_function_statement"}),
        container_types=frozenset({
            "class_declaration",
            "interface_declaration",
            "namespace_declaration",
        }),
    ),
    "java": LanguageConfig(
        class_types=frozenset({
            "class_declaration",
            "interface_declaration",
            "enum_declaration",
        }),
        function_types=frozenset({"method_declaration", "constructor_declaration"}),
        container_types=frozenset({"class_declaration", "interface_declaration"}),
    ),
    "kotlin": LanguageConfig(
        class_types=frozenset({"class_declaration", "object_declaration"}),
        function_types=frozenset({"function_declaration"}),
        container_types=frozenset({"class_declaration", "object_declaration"}),
    ),
    "ruby": LanguageConfig(
        class_types=frozenset({"class", "module"}),
        function_types=frozenset({"method", "singleton_method"}),
        container_types=frozenset({"class", "module"}),
    ),
    "rust": LanguageConfig(
        class_types=frozenset({"struct_item", "enum_item", "trait_item"}),
        function_types=frozenset({"function_item", "function_signature_item"}),
        container_types=frozenset({"impl_item", "trait_item"}),
    ),
    "swift": LanguageConfig(
        class_types=frozenset({
            "class_declaration",
            "protocol_declaration",
            "struct_declaration",
            "enum_declaration",
        }),
        function_types=frozenset({"function_declaration", "init_declaration"}),
        container_types=frozenset({
            "class_declaration",
            "protocol_declaration",
            "struct_declaration",
        }),
    ),
}

SUBTYPE_MAP: dict[str, str] = {
    # C/C++
    "struct_specifier": "struct",
    "enum_specifier": "enum",
    # C#
    "struct_declaration": "struct",
    "interface_declaration": "interface",
    "enum_declaration": "enum",
    # Kotlin
    "object_declaration": "object",
    # Ruby
    "module": "module",
    # Rust
    "struct_item": "struct",
    "enum_item": "enum",
    "trait_item": "trait",
    # Swift
    "protocol_declaration": "protocol",
}

# ---------------------------------------------------------------------------
# Grammar imports & parser cache
# ---------------------------------------------------------------------------

# Module-level dict: language name -> grammar module
_GRAMMAR_MODULES: dict[str, object] = {}

# Module-level dict: language name -> cached Parser
_PARSERS: dict[str, tree_sitter.Parser] = {}

_IDENTIFIER_TYPES = frozenset({
    "identifier",
    "type_identifier",
    "simple_identifier",
    "constant",
})

_BODY_TYPES = frozenset({
    "field_declaration_list",
    "declaration_list",
    "class_body",
    "enum_body",
    "interface_body",
    "block",
})

_INHERITANCE_LIST_TYPES = frozenset({
    "base_class_clause",
    "base_list",
    "delegation_specifiers",
    "type_inheritance_clause",
})


def _import_grammar(language: str) -> object:
    """Lazily import the tree-sitter grammar module for *language*."""
    if language in _GRAMMAR_MODULES:
        return _GRAMMAR_MODULES[language]

    import importlib

    module_name_map: dict[str, str] = {
        "c": "tree_sitter_c",
        "cpp": "tree_sitter_cpp",
        "csharp": "tree_sitter_c_sharp",
        "java": "tree_sitter_java",
        "kotlin": "tree_sitter_kotlin",
        "ruby": "tree_sitter_ruby",
        "rust": "tree_sitter_rust",
        "swift": "tree_sitter_swift",
    }

    mod_name = module_name_map.get(language)
    if mod_name is None:
        raise ValueError(f"No grammar module configured for language: {language}")

    mod = importlib.import_module(mod_name)
    _GRAMMAR_MODULES[language] = mod
    return mod


def _get_parser(language: str) -> tree_sitter.Parser:
    """Return a cached tree-sitter ``Parser`` for *language*, creating it on first use."""
    if language in _PARSERS:
        return _PARSERS[language]

    grammar_mod = _import_grammar(language)
    lang = tree_sitter.Language(grammar_mod.language())  # type: ignore[attr-defined]
    parser = tree_sitter.Parser(lang)
    _PARSERS[language] = parser
    return parser


# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------

def _extract_name(node: tree_sitter.Node) -> str | None:
    """Extract a name from an AST node using a fallback chain.

    1. ``child_by_field_name("name")``
    2. ``child_by_field_name("declarator")`` -- C/C++ pattern
    3. First identifier child
    """
    # Standard: most languages use a "name" field
    name_node = node.child_by_field_name("name")
    if name_node is not None:
        return name_node.text.decode()

    # C/C++ functions: name lives inside the "declarator" field
    declarator = node.child_by_field_name("declarator")
    if declarator is not None:
        if declarator.type == "function_declarator":
            inner = declarator.child_by_field_name("declarator")
            if inner is not None:
                return inner.text.decode()
        if declarator.type in ("identifier", "field_identifier"):
            return declarator.text.decode()
        # Qualified declarator (C++): qualified_identifier -> name
        q_name = declarator.child_by_field_name("name")
        if q_name is not None:
            return q_name.text.decode()
        return declarator.text.decode()

    # Fallback: first identifier child (includes simple_identifier for Kotlin)
    for child in node.children:
        if child.type in _IDENTIFIER_TYPES:
            return child.text.decode()

    return None


def _find_body(node: tree_sitter.Node) -> tree_sitter.Node | None:
    """Find the body/block child of *node*."""
    body = node.child_by_field_name("body")
    if body is not None:
        return body

    for child in node.children:
        if child.type in _BODY_TYPES:
            return child

    return None


def _collect_type_identifiers(node: tree_sitter.Node) -> list[str]:
    """Collect ``type_identifier`` / ``identifier`` / ``simple_identifier`` texts
    from *node* and its descendants."""
    names: list[str] = []
    for child in node.children:
        if child.type in _IDENTIFIER_TYPES:
            names.append(child.text.decode())
        elif child.named_child_count > 0:
            names.extend(_collect_type_identifiers(child))
    return names


def _extract_inheritance(node: tree_sitter.Node) -> tuple[list[str], list[str]]:
    """Extract superclasses and interfaces from a class-like AST node.

    Returns ``(superclasses, interfaces)``.
    """
    superclasses: list[str] = []
    interfaces: list[str] = []

    # Java/Ruby: child_by_field_name("superclass")
    superclass_field = node.child_by_field_name("superclass")
    if superclass_field is not None:
        for child in superclass_field.children:
            if child.type in ("type_identifier", "constant", "scope_resolution"):
                superclasses.append(child.text.decode())
        if not superclasses:
            superclasses.extend(_collect_type_identifiers(superclass_field))

    # Java: child_by_field_name("interfaces") -> type_list -> type_identifier children
    interfaces_field = node.child_by_field_name("interfaces")
    if interfaces_field is not None:
        interfaces.extend(_collect_type_identifiers(interfaces_field))

    # C++: base_class_clause; C#: base_list; Kotlin: delegation_specifiers
    # Swift: type_inheritance_clause
    for child in node.children:
        if child.type in _INHERITANCE_LIST_TYPES:
            superclasses.extend(_collect_type_identifiers(child))

    return superclasses, interfaces


def _extract_preceding_doc(node: tree_sitter.Node) -> str | None:
    """Extract documentation comment from the preceding sibling(s) of *node*.

    Handles both block comments (Javadoc-style ``/** ... */``) and consecutive
    line comments (``//`` / ``///``).
    """
    prev = node.prev_named_sibling
    if prev is None:
        return None

    # Block comment starting with /**
    if prev.type in ("comment", "block_comment"):
        text = prev.text.decode()
        if text.startswith("/**"):
            cleaned = re.sub(r"^/\*\*\s*", "", text)
            cleaned = re.sub(r"\s*\*/$", "", cleaned)
            lines = cleaned.split("\n")
            lines = [re.sub(r"^\s*\*\s?", "", line) for line in lines]
            cleaned = "\n".join(lines).strip()
            return cleaned or None

    # Consecutive line comments
    if prev.type in ("comment", "line_comment"):
        comments: list[str] = []
        cur: tree_sitter.Node | None = prev
        while cur is not None and cur.type in ("comment", "line_comment"):
            comments.append(cur.text.decode())
            cur = cur.prev_named_sibling
        comments.reverse()
        cleaned = "\n".join(
            re.sub(r"^///?\s?", "", line) for line in comments
        ).strip()
        return cleaned or None

    return None


def _extract_function(node: tree_sitter.Node) -> CodeSymbol | None:
    """Extract a function-like symbol from *node*."""
    name = _extract_name(node)
    if name is None:
        return None

    # C/C++ parameters are nested: declarator -> function_declarator -> parameters
    params_node = node.child_by_field_name("parameters")
    if params_node is None:
        decl = node.child_by_field_name("declarator")
        if decl is not None and decl.type == "function_declarator":
            params_node = decl.child_by_field_name("parameters")

    signature = params_node.text.decode() if params_node is not None else None

    return CodeSymbol(
        name=name,
        kind="function",
        start_line=node.start_point[0] + 1,
        end_line=node.end_point[0] + 1,
        signature=signature,
    )


def _extract_methods(body: tree_sitter.Node, config: LanguageConfig) -> list[CodeSymbol]:
    """Extract methods (and nested classes) from a class/container body."""
    methods: list[CodeSymbol] = []
    for child in body.children:
        if child.type in config.function_types:
            sym = _extract_function(child)
            if sym is not None:
                methods.append(sym)
        elif child.type in config.class_types:
            sym = _extract_class(child, config)
            if sym is not None:
                methods.append(sym)
    return methods


def _extract_class(node: tree_sitter.Node, config: LanguageConfig) -> CodeSymbol | None:
    """Extract a class-like symbol from *node*."""
    name = _extract_name(node)
    if name is None:
        return None

    body = _find_body(node)
    children = _extract_methods(body, config) if body is not None else []
    subtype = SUBTYPE_MAP.get(node.type)
    superclasses, interfaces = _extract_inheritance(node)

    return CodeSymbol(
        name=name,
        kind="class",
        start_line=node.start_point[0] + 1,
        end_line=node.end_point[0] + 1,
        children=children,
        subtype=subtype,
        superclasses=superclasses if superclasses else None,
        interfaces=interfaces if interfaces else None,
    )


def _extract_node(node: tree_sitter.Node, config: LanguageConfig) -> CodeSymbol | None:
    """Try to extract a symbol from *node* (class-like or function-like)."""
    sym: CodeSymbol | None = None
    if node.type in config.class_types:
        sym = _extract_class(node, config)
    elif node.type in config.function_types:
        sym = _extract_function(node)
    if sym is not None:
        sym.docs = _extract_preceding_doc(node)
    return sym


def _walk_top_level(node: tree_sitter.Node, config: LanguageConfig) -> list[CodeSymbol]:
    """Walk top-level children, extracting classes and functions."""
    symbols: list[CodeSymbol] = []
    for child in node.children:
        sym = _extract_node(child, config)
        if sym is not None:
            symbols.append(sym)
        elif child.type in config.container_types:
            # Container without a name (e.g., Rust `impl Foo {}`) -- extract children as top-level
            body = _find_body(child)
            if body is not None:
                symbols.extend(_walk_top_level(body, config))
        else:
            # Recurse into wrapper nodes (e.g., namespace bodies, extern blocks)
            symbols.extend(_walk_top_level(child, config))
    return symbols


# ---------------------------------------------------------------------------
# Public extractor class
# ---------------------------------------------------------------------------

class GenericExtractor(SymbolExtractor):
    """Table-driven symbol extractor for C, C++, C#, Java, Kotlin, Ruby, Rust, and Swift."""

    extensions: ClassVar[tuple[str, ...]] = (
        ".c", ".cpp", ".h", ".hpp", ".cs", ".java", ".kt", ".rb", ".rs", ".swift",
    )
    language_name: ClassVar[str] = "generic"

    def extract(self, source_bytes: bytes) -> ExtractionResult:
        """Parse *source_bytes* using a default language (Java).

        Prefer :meth:`extract_for_extension` when the file extension is known.
        """
        return self.extract_for_extension(source_bytes, ".java")

    def extract_for_extension(self, source_bytes: bytes, extension: str) -> ExtractionResult:
        """Parse *source_bytes* and return extracted symbols for the given *extension*."""
        language = EXTENSION_LANGUAGE_MAP.get(extension)
        if language is None or language not in LANGUAGE_CONFIGS:
            return ExtractionResult(symbols=[], language=extension)

        config = LANGUAGE_CONFIGS[language]
        parser = _get_parser(language)
        tree = parser.parse(source_bytes)
        symbols = _walk_top_level(tree.root_node, config)
        return ExtractionResult(symbols=symbols, language=language, root_node=tree.root_node)
