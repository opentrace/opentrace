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
};

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  c: {
    classTypes: new Set(['struct_specifier', 'enum_specifier']),
    functionTypes: new Set(['function_definition']),
    containerTypes: new Set(),
  },
  cpp: {
    classTypes: new Set([
      'class_specifier',
      'struct_specifier',
      'enum_specifier',
    ]),
    functionTypes: new Set(['function_definition']),
    containerTypes: new Set(['class_specifier', 'namespace_definition']),
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
  },
  java: {
    classTypes: new Set([
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
    ]),
    functionTypes: new Set(['method_declaration', 'constructor_declaration']),
    containerTypes: new Set(['class_declaration', 'interface_declaration']),
  },
  kotlin: {
    classTypes: new Set(['class_declaration', 'object_declaration']),
    functionTypes: new Set(['function_declaration']),
    containerTypes: new Set(['class_declaration', 'object_declaration']),
  },
  ruby: {
    classTypes: new Set(['class', 'module']),
    functionTypes: new Set(['method', 'singleton_method']),
    containerTypes: new Set(['class', 'module']),
  },
  rust: {
    classTypes: new Set(['struct_item', 'enum_item', 'trait_item']),
    functionTypes: new Set(['function_item', 'function_signature_item']),
    containerTypes: new Set(['impl_item', 'trait_item']),
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
  },
};

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
  if (config.classTypes.has(node.type)) {
    return extractClass(node, config);
  }
  if (config.functionTypes.has(node.type)) {
    return extractFunction(node);
  }
  return null;
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

function extractFunction(node: SyntaxNode): CodeSymbol | null {
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
      const sym = extractFunction(child);
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
