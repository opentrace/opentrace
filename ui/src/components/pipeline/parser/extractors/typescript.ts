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
 * TypeScript/TSX symbol extractor using web-tree-sitter.
 * Ported from agent/src/opentrace_agent/sources/code/extractors/typescript_extractor.py
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CallRef, CodeSymbol, ExtractionResult } from '../../types';

const CLASS_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
]);
const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
]);
const METHOD_TYPES = new Set(['method_definition', 'public_field_definition']);

/** Extract a JSDoc/TSDoc comment from the preceding sibling of an AST node.
 *  Checks both the node itself and its parent (for `export_statement` wrapping). */
function extractJSDoc(node: SyntaxNode): string | undefined {
  let prev = node.previousNamedSibling;
  // If no JSDoc on the node itself, check the parent (handles `export function ...`)
  if (
    (!prev || prev.type !== 'comment') &&
    node.parent?.type === 'export_statement'
  ) {
    prev = node.parent.previousNamedSibling;
  }
  if (!prev || prev.type !== 'comment') return undefined;
  const text = prev.text;
  if (!text.startsWith('/**')) return undefined;
  // Strip /** ... */ delimiters and leading ` * ` prefixes
  const cleaned = text
    .replace(/^\/\*\*\s*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  return cleaned || undefined;
}

export function extractTypeScript(
  rootNode: SyntaxNode,
  language = 'typescript',
): ExtractionResult {
  const symbols = walkNode(rootNode);
  return { symbols, language, rootNode };
}

function walkNode(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    if (CLASS_TYPES.has(child.type)) {
      const sym = extractClass(child);
      if (sym) symbols.push(sym);
    } else if (FUNCTION_TYPES.has(child.type)) {
      const sym = extractFunction(child);
      if (sym) symbols.push(sym);
    } else if (child.type === 'lexical_declaration') {
      symbols.push(...extractLexicalDeclaration(child));
    } else if (child.type === 'export_statement') {
      // Unwrap `export class ...` / `export function ...`
      symbols.push(...walkNode(child));
    }
  }
  return symbols;
}

function extractClass(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const children = walkClassBody(node);
  const { superclasses, interfaces } = extractClassHeritage(node);
  const docs = extractJSDoc(node);
  return {
    name: nameNode.text,
    kind: 'class',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: null,
    children,
    calls: [],
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    superclasses: superclasses.length > 0 ? superclasses : undefined,
    interfaces: interfaces.length > 0 ? interfaces : undefined,
    docs,
  };
}

/** Extract extends/implements from a class_heritage child. */
function extractClassHeritage(node: SyntaxNode): {
  superclasses: string[];
  interfaces: string[];
} {
  const superclasses: string[] = [];
  const interfaces: string[] = [];
  for (const child of node.children) {
    if (child.type === 'class_heritage') {
      for (const clause of child.children) {
        if (clause.type === 'extends_clause') {
          superclasses.push(...collectHeritageNames(clause));
        } else if (clause.type === 'implements_clause') {
          interfaces.push(...collectHeritageNames(clause));
        }
      }
    }
  }
  return { superclasses, interfaces };
}

/** Collect type names from an extends/implements clause. */
function collectHeritageNames(clause: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of clause.children) {
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      names.push(child.text);
    } else if (child.type === 'generic_type') {
      // e.g., `Map<string, number>` — extract just the base name
      const nameNode = child.childForFieldName('name');
      if (nameNode) names.push(nameNode.text);
    }
  }
  return names;
}

function walkClassBody(node: SyntaxNode): CodeSymbol[] {
  const body = node.childForFieldName('body');
  if (!body) return [];
  const methods: CodeSymbol[] = [];
  for (const child of body.children) {
    if (METHOD_TYPES.has(child.type)) {
      const sym = extractMethod(child);
      if (sym) methods.push(sym);
    }
  }
  return methods;
}

function extractFunction(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const typeSignature = paramsNode ? extractTypeSignature(paramsNode) : null;
  const returnType = extractReturnType(node);
  const bodyNode = node.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  const docs = extractJSDoc(node);
  return {
    name: nameNode.text,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    docs,
    typeSignature,
    returnType,
  };
}

function extractMethod(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const typeSignature = paramsNode ? extractTypeSignature(paramsNode) : null;
  const returnType = extractReturnType(node);
  const bodyNode = node.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  const docs = extractJSDoc(node);
  return {
    name: nameNode.text,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    docs,
    typeSignature,
    returnType,
  };
}

function extractLexicalDeclaration(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    if (child.type === 'variable_declarator') {
      const nameNode = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !valueNode) continue;
      const name = nameNode.text;
      if (
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression'
      ) {
        const sym = extractArrowFunction(name, node, valueNode);
        if (sym) symbols.push(sym);
      } else if (valueNode.type === 'class') {
        const sym = extractClassExpression(name, node, valueNode);
        if (sym) symbols.push(sym);
      }
    }
  }
  return symbols;
}

function extractArrowFunction(
  name: string,
  declNode: SyntaxNode,
  valueNode: SyntaxNode,
): CodeSymbol {
  const paramsNode = valueNode.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const typeSignature = paramsNode ? extractTypeSignature(paramsNode) : null;
  const returnType = extractReturnType(valueNode);
  const bodyNode = valueNode.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  const docs = extractJSDoc(declNode);
  return {
    name,
    kind: 'function',
    startLine: declNode.startPosition.row + 1,
    endLine: declNode.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    docs,
    typeSignature,
    returnType,
  };
}

function extractClassExpression(
  name: string,
  declNode: SyntaxNode,
  valueNode: SyntaxNode,
): CodeSymbol {
  const children = walkClassBody(valueNode);
  const { superclasses, interfaces } = extractClassHeritage(valueNode);
  const docs = extractJSDoc(declNode);
  return {
    name,
    kind: 'class',
    startLine: declNode.startPosition.row + 1,
    endLine: declNode.endPosition.row + 1,
    signature: null,
    children,
    calls: [],
    receiverVar: null,
    receiverType: null,
    paramTypes: null,
    superclasses: superclasses.length > 0 ? superclasses : undefined,
    interfaces: interfaces.length > 0 ? interfaces : undefined,
    docs,
  };
}

/** Build a Java-style type signature from TS/JS parameter type annotations.
 *  Returns "()" for zero-param functions, "(string,number)" when all params are typed,
 *  or null when any param lacks a type annotation. */
function extractTypeSignature(paramsNode: SyntaxNode): string | null {
  const types: string[] = [];
  let paramCount = 0;

  for (const child of paramsNode.namedChildren) {
    if (
      child.type === 'required_parameter' ||
      child.type === 'optional_parameter'
    ) {
      paramCount++;
      const typeAnnotation = child.childForFieldName('type');
      if (typeAnnotation) {
        types.push(normalizeTypeName(typeAnnotation.text));
      }
    } else if (child.type === 'rest_parameter') {
      paramCount++;
      const typeAnnotation = child.childForFieldName('type');
      if (typeAnnotation) {
        types.push(normalizeTypeName(typeAnnotation.text) + '[]');
      }
    }
  }

  // Zero params → "()" for typed languages
  if (paramCount === 0) return '()';
  // All params must be typed for a valid signature
  if (types.length !== paramCount) return null;
  return `(${types.join(',')})`;
}

/** Extract the return type annotation from a function/method/arrow node. */
function extractReturnType(node: SyntaxNode): string | null {
  const returnTypeNode = node.childForFieldName('return_type');
  if (!returnTypeNode) return null;
  return normalizeTypeName(returnTypeNode.text);
}

/** Normalize a type annotation to a clean Java-style type name. */
function normalizeTypeName(raw: string): string {
  return raw
    .replace(/\s+/g, '') // strip whitespace
    .split('.')
    .pop()!; // take leaf of qualified names
}

function collectCalls(node: SyntaxNode): CallRef[] {
  const calls: CallRef[] = [];

  // Extract call from this node (handles both direct call_expression nodes
  // like concise arrow bodies, and call_expression children found via recursion)
  if (node.type === 'call_expression') {
    const funcNode = node.childForFieldName('function');
    if (funcNode && funcNode.type === 'identifier') {
      calls.push({ name: funcNode.text, receiver: null, kind: 'bare' });
    } else if (funcNode && funcNode.type === 'member_expression') {
      const objNode = funcNode.childForFieldName('object');
      const propNode = funcNode.childForFieldName('property');
      if (objNode && propNode) {
        calls.push({
          name: propNode.text,
          receiver: objNode.text,
          kind: 'attribute',
        });
      }
    }
  }

  for (const child of node.children) {
    calls.push(...collectCalls(child));
  }
  return calls;
}
