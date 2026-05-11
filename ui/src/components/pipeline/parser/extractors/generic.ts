/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Generic table-driven symbol extractor for languages without bespoke extractors.
 *
 * Uses per-language configuration tables to identify class-like and function-like
 * AST node types. Extracts names, line numbers, and parent–child relationships.
 *
 * Limitations (acceptable for v1):
 *   - calls array is always empty (no call extraction)
 *   - No import analysis (importAnalyzer returns empty for unknown languages)
 *   - receiverVar/receiverType always null
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CodeSymbol, ExtractionResult } from '../../types';

interface LanguageConfig {
  /** AST node types treated as class-like (struct, enum, interface, etc.) */
  classTypes: Set<string>;
  /** AST node types treated as function-like */
  functionTypes: Set<string>;
  /** AST node types whose body should be recursed into for child methods */
  containerTypes: Set<string>;
  /** AST node types that represent individual parameters in a param list */
  paramChildTypes?: Set<string>;
  /** Whether the language has mandatory type annotations (enables typeSignature) */
  typed?: boolean;
}

/** Maps AST node types → subtype strings for class-like nodes. */
const SUBTYPE_MAP: Record<string, string> = {
  // C/C++
  struct_specifier: 'struct',
  enum_specifier: 'enum',
  // C#
  struct_declaration: 'struct',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  // Kotlin
  object_declaration: 'object',
  // Ruby
  module: 'module',
  // Rust
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  // Swift
  protocol_declaration: 'protocol',
  // PHP (interface_declaration/enum_declaration already mapped above for C#)
  trait_declaration: 'trait',
};

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  c: {
    classTypes: new Set(['struct_specifier', 'enum_specifier']),
    functionTypes: new Set(['function_definition']),
    containerTypes: new Set(),
    paramChildTypes: new Set(['parameter_declaration']),
    typed: true,
  },
  cpp: {
    classTypes: new Set([
      'class_specifier',
      'struct_specifier',
      'enum_specifier',
    ]),
    functionTypes: new Set(['function_definition']),
    containerTypes: new Set(['class_specifier', 'namespace_definition']),
    paramChildTypes: new Set(['parameter_declaration']),
    typed: true,
  },
  csharp: {
    classTypes: new Set([
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
    ]),
    functionTypes: new Set(['method_declaration', 'local_function_statement']),
    containerTypes: new Set([
      'class_declaration',
      'interface_declaration',
      'namespace_declaration',
    ]),
    paramChildTypes: new Set(['parameter']),
    typed: true,
  },
  java: {
    classTypes: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
    ]),
    functionTypes: new Set(['method_declaration', 'constructor_declaration']),
    containerTypes: new Set(['class_declaration', 'interface_declaration']),
    paramChildTypes: new Set(['formal_parameter', 'spread_parameter']),
    typed: true,
  },
  kotlin: {
    classTypes: new Set(['class_declaration', 'object_declaration']),
    functionTypes: new Set(['function_declaration']),
    containerTypes: new Set(['class_declaration', 'object_declaration']),
    paramChildTypes: new Set(['function_value_parameter']),
    typed: true,
  },
  ruby: {
    classTypes: new Set(['class', 'module']),
    functionTypes: new Set(['method', 'singleton_method']),
    containerTypes: new Set(['class', 'module']),
    // Ruby has no type annotations
  },
  rust: {
    classTypes: new Set(['struct_item', 'enum_item', 'trait_item']),
    functionTypes: new Set(['function_item', 'function_signature_item']),
    containerTypes: new Set(['impl_item', 'trait_item']),
    paramChildTypes: new Set(['parameter']),
    typed: true,
  },
  swift: {
    classTypes: new Set([
      'class_declaration',
      'protocol_declaration',
      'struct_declaration',
      'enum_declaration',
    ]),
    functionTypes: new Set(['function_declaration', 'init_declaration']),
    containerTypes: new Set([
      'class_declaration',
      'protocol_declaration',
      'struct_declaration',
    ]),
    paramChildTypes: new Set(['parameter']),
    typed: true,
  },
  php: {
    classTypes: new Set([
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
    ]),
    functionTypes: new Set(['function_definition', 'method_declaration']),
    containerTypes: new Set([
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
      'enum_declaration',
      'namespace_definition',
    ]),
    paramChildTypes: new Set([
      'simple_parameter',
      'variadic_parameter',
      'property_promotion_parameter',
    ]),
    // PHP has optional type hints — leave `typed` off so untyped params don't
    // invalidate the signature
  },
};

/** Extract documentation comment from the preceding sibling(s) of an AST node.
 *  Handles both block comments (Javadoc-style) and consecutive line comments. */
function extractPrecedingDoc(node: SyntaxNode): string | undefined {
  const prev = node.previousNamedSibling;
  if (!prev) return undefined;

  // Block comment (Java/C/C++/Kotlin Javadoc): single `comment` or `block_comment` node starting with `/**`
  if (
    (prev.type === 'comment' || prev.type === 'block_comment') &&
    prev.text.startsWith('/**')
  ) {
    const cleaned = prev.text
      .replace(/^\/\*\*\s*/, '')
      .replace(/\s*\*\/$/, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, ''))
      .join('\n')
      .trim();
    return cleaned || undefined;
  }

  // Consecutive line comments (C#, Rust, Swift, etc.): `//` or `///`
  if (prev.type === 'comment' || prev.type === 'line_comment') {
    const comments: string[] = [];
    let cur: SyntaxNode | null = prev;
    while (cur && (cur.type === 'comment' || cur.type === 'line_comment')) {
      comments.push(cur.text);
      cur = cur.previousNamedSibling;
    }
    const cleaned = comments
      .reverse()
      .map((line) => line.replace(/^\/\/\/?\s?/, ''))
      .join('\n')
      .trim();
    return cleaned || undefined;
  }

  return undefined;
}

export function extractGeneric(
  rootNode: SyntaxNode,
  language: string,
): ExtractionResult {
  const config = LANGUAGE_CONFIGS[language];
  if (!config) {
    return { symbols: [], language, rootNode };
  }
  const symbols = walkTopLevel(rootNode, config);
  return { symbols, language, rootNode };
}

/** Walk top-level children, extracting classes and functions. */
function walkTopLevel(node: SyntaxNode, config: LanguageConfig): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    const sym = extractNode(child, config);
    if (sym) {
      symbols.push(sym);
    } else if (config.containerTypes.has(child.type)) {
      // Container without a name (e.g., Rust `impl Foo {}`) — extract children as top-level
      const body = findBody(child);
      if (body) {
        symbols.push(...walkTopLevel(body, config));
      }
    } else {
      // Recurse into wrapper nodes (e.g., namespace bodies, extern blocks)
      symbols.push(...walkTopLevel(child, config));
    }
  }
  return symbols;
}

function extractNode(
  node: SyntaxNode,
  config: LanguageConfig,
): CodeSymbol | null {
  let sym: CodeSymbol | null = null;
  if (config.classTypes.has(node.type)) {
    sym = extractClass(node, config);
  } else if (config.functionTypes.has(node.type)) {
    sym = extractFunction(node, config);
  }
  if (sym) {
    sym.docs = extractPrecedingDoc(node);
  }
  return sym;
}

function extractClass(
  node: SyntaxNode,
  config: LanguageConfig,
): CodeSymbol | null {
  const name = extractName(node);
  if (!name) return null;

  const body = findBody(node);
  const children = body ? extractMethods(body, config) : [];
  const subtype = SUBTYPE_MAP[node.type];
  const { superclasses, interfaces } = extractInheritance(node);

  return {
    name,
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: null,
    children,
    calls: [],
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    subtype,
    superclasses: superclasses.length > 0 ? superclasses : undefined,
    interfaces: interfaces.length > 0 ? interfaces : undefined,
  };
}

function extractFunction(
  node: SyntaxNode,
  config?: LanguageConfig,
): CodeSymbol | null {
  const name = extractName(node);
  if (!name) return null;

  // C/C++ parameters are nested: declarator → function_declarator → parameters
  let paramsNode = node.childForFieldName('parameters');
  if (!paramsNode) {
    const decl = node.childForFieldName('declarator');
    if (decl?.type === 'function_declarator') {
      paramsNode = decl.childForFieldName('parameters');
    }
  }
  const signature = paramsNode ? paramsNode.text : null;
  const typeSignature =
    paramsNode && config
      ? extractGenericTypeSignature(paramsNode, config)
      : null;
  const returnType = config?.typed ? extractGenericReturnType(node) : null;

  return {
    name,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    children: [],
    calls: [],
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    typeSignature,
    returnType,
  };
}

/**
 * Extract superclasses and interfaces from a class-like AST node.
 * Each language grammar represents inheritance differently.
 */
function extractInheritance(node: SyntaxNode): {
  superclasses: string[];
  interfaces: string[];
} {
  const superclasses: string[] = [];
  const interfaces: string[] = [];

  // Java/Ruby: childForFieldName("superclass")
  //   Java → "superclass" node wrapping type_identifier child
  //   Ruby → "superclass" node wrapping constant child
  const superclassField = node.childForFieldName('superclass');
  if (superclassField) {
    for (const child of superclassField.children) {
      if (
        child.type === 'type_identifier' ||
        child.type === 'constant' ||
        child.type === 'scope_resolution'
      ) {
        superclasses.push(child.text);
      }
    }
    // If no named identifier child found, try collecting recursively
    if (superclasses.length === 0) {
      const names = collectTypeIdentifiers(superclassField);
      superclasses.push(...names);
    }
  }

  // Java: childForFieldName("interfaces") → type_list → type_identifier children
  const interfacesField = node.childForFieldName('interfaces');
  if (interfacesField) {
    interfaces.push(...collectTypeIdentifiers(interfacesField));
  }

  // C++: base_class_clause; C#: base_list; Kotlin: delegation_specifiers
  // Swift: type_inheritance_clause — all use a single list node for supertypes
  for (const child of node.children) {
    if (
      child.type === 'base_class_clause' ||
      child.type === 'base_list' ||
      child.type === 'delegation_specifiers' ||
      child.type === 'type_inheritance_clause'
    ) {
      superclasses.push(...collectTypeIdentifiers(child));
    }
  }

  return { superclasses, interfaces };
}

/** Collect type_identifier / identifier / simple_identifier texts from a parent node. */
function collectTypeIdentifiers(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of node.children) {
    if (
      child.type === 'type_identifier' ||
      child.type === 'identifier' ||
      child.type === 'simple_identifier'
    ) {
      names.push(child.text);
    } else if (child.namedChildCount > 0) {
      // Recurse into wrapper nodes (e.g., Java type_list → type_identifier,
      // Kotlin delegation_specifier → user_type → simple_identifier,
      // Swift type_inheritance_clause → inheritance_specifier → type)
      names.push(...collectTypeIdentifiers(child));
    }
  }
  return names;
}

/** Extract methods from a class/container body. */
function extractMethods(
  body: SyntaxNode,
  config: LanguageConfig,
): CodeSymbol[] {
  const methods: CodeSymbol[] = [];
  for (const child of body.children) {
    if (config.functionTypes.has(child.type)) {
      const sym = extractFunction(child, config);
      if (sym) methods.push(sym);
    } else if (config.classTypes.has(child.type)) {
      // Nested class
      const sym = extractClass(child, config);
      if (sym) methods.push(sym);
    }
  }
  return methods;
}

/**
 * Extract the name from an AST node using a fallback chain:
 *   1. childForFieldName("name")
 *   2. childForFieldName("declarator") — C/C++ pattern
 *   3. First identifier child
 */
function extractName(node: SyntaxNode): string | null {
  // Standard: most languages use a "name" field
  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    // For C/C++, the name field of a class_specifier/struct_specifier is the type name
    return nameNode.text;
  }

  // C/C++ functions: name is in the "declarator" field
  const declarator = node.childForFieldName('declarator');
  if (declarator) {
    // declarator might be a function_declarator wrapping an identifier
    if (declarator.type === 'function_declarator') {
      const inner = declarator.childForFieldName('declarator');
      if (inner) return inner.text;
    }
    if (
      declarator.type === 'identifier' ||
      declarator.type === 'field_identifier'
    ) {
      return declarator.text;
    }
    // Qualified declarator (C++): qualified_identifier → name
    const qName = declarator.childForFieldName('name');
    if (qName) return qName.text;
    return declarator.text;
  }

  // Fallback: first identifier child (includes simple_identifier for Kotlin)
  for (const child of node.children) {
    if (
      child.type === 'identifier' ||
      child.type === 'type_identifier' ||
      child.type === 'simple_identifier' ||
      child.type === 'constant'
    ) {
      return child.text;
    }
  }

  return null;
}

// --- Type signature extraction ---

/** AST node types that represent type annotations. */
const TYPE_NODE_TYPES = new Set([
  'type_identifier',
  'predefined_type',
  'primitive_type',
  'user_type',
  'generic_type',
  'template_type',
  'pointer_type',
  'slice_type',
  'array_type',
  'nullable_type',
  'reference_type',
  'scoped_type_identifier',
  'simple_type',
  'optional_type',
]);

/** Build a Java-style type signature from a generic parameter list.
 *  Returns "(String,int)" for typed languages, or null for untyped ones. */
function extractGenericTypeSignature(
  paramsNode: SyntaxNode,
  config: LanguageConfig,
): string | null {
  if (!config.paramChildTypes || !config.typed) return null;

  const types: string[] = [];
  let paramCount = 0;

  for (const child of paramsNode.namedChildren) {
    if (config.paramChildTypes.has(child.type)) {
      paramCount++;
      const typeName = extractParamType(child);
      if (typeName) {
        types.push(typeName);
      }
    }
  }

  // Zero params → "()" for typed languages
  if (paramCount === 0) return '()';
  // All params must be typed for a valid signature
  if (types.length !== paramCount) return null;
  return `(${types.join(',')})`;
}

/** Extract the type name from a single parameter AST node. */
function extractParamType(paramNode: SyntaxNode): string | null {
  // Strategy 1: field name 'type' — works for Java, C#, Rust, C/C++
  const typeField = paramNode.childForFieldName('type');
  if (typeField) return normalizeTypeName(typeField.text);

  // Strategy 2: scan named children for type-like nodes
  for (const child of paramNode.namedChildren) {
    if (TYPE_NODE_TYPES.has(child.type)) {
      return normalizeTypeName(child.text);
    }
    // Kotlin: function_value_parameter → parameter → user_type
    if (child.namedChildCount > 0) {
      for (const sub of child.namedChildren) {
        if (TYPE_NODE_TYPES.has(sub.type)) {
          return normalizeTypeName(sub.text);
        }
      }
    }
  }
  return null;
}

/** Normalize a type name to a clean Java-style format.
 *  Strips const qualifiers and namespace prefixes but preserves pointer/reference
 *  markers (* and &) since they distinguish overloads in C++ and C#. */
function normalizeTypeName(raw: string): string {
  let name = raw
    .replace(/\bconst\b\s*/g, '')
    .replace(/\s*([*&])\s*/g, '$1') // Normalize spacing around * and &
    .trim();
  // Take leaf of qualified names (std::string → string, java.util.List → List)
  if (name.includes('::')) name = name.split('::').pop()!;
  if (name.includes('.')) name = name.split('.').pop()!;
  return name;
}

/** Extract the return type from a function node.
 *  Tries field names used across languages: 'type' (Java/C#), 'return_type' (Rust/Swift),
 *  then falls back to C/C++ pattern (type specifier before declarator). */
function extractGenericReturnType(node: SyntaxNode): string | null {
  // Java/C#/Kotlin: method_declaration has a 'type' field for return type
  const typeField = node.childForFieldName('type');
  if (typeField && TYPE_NODE_TYPES.has(typeField.type)) {
    return normalizeTypeName(typeField.text);
  }

  // Rust/Swift: 'return_type' field
  const returnTypeField = node.childForFieldName('return_type');
  if (returnTypeField) {
    return normalizeTypeName(returnTypeField.text);
  }

  // C/C++: return type is a type specifier child before the declarator
  for (const child of node.namedChildren) {
    if (
      child.type === 'primitive_type' ||
      child.type === 'type_identifier' ||
      child.type === 'template_type'
    ) {
      return normalizeTypeName(child.text);
    }
    // Stop scanning once we hit the declarator or body
    if (
      child.type === 'function_declarator' ||
      child.type === 'compound_statement'
    ) {
      break;
    }
  }

  return null;
}

/** Find the body/block child of a node. */
function findBody(node: SyntaxNode): SyntaxNode | null {
  // Try common field names
  const body = node.childForFieldName('body');
  if (body) return body;

  // Some grammars use "members" or "declaration_list"
  for (const child of node.children) {
    if (
      child.type === 'field_declaration_list' ||
      child.type === 'declaration_list' ||
      child.type === 'class_body' ||
      child.type === 'enum_body' ||
      child.type === 'interface_body' ||
      child.type === 'block'
    ) {
      return child;
    }
  }

  return null;
}
