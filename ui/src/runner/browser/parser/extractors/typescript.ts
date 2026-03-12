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
  const bodyNode = node.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
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
  };
}

function extractMethod(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const bodyNode = node.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
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
  const bodyNode = valueNode.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
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
  };
}

function extractClassExpression(
  name: string,
  declNode: SyntaxNode,
  valueNode: SyntaxNode,
): CodeSymbol {
  const children = walkClassBody(valueNode);
  const { superclasses, interfaces } = extractClassHeritage(valueNode);
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
  };
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
