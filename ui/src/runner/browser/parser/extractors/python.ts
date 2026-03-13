/**
 * Python symbol extractor using web-tree-sitter.
 * Ported from agent/src/opentrace_agent/sources/code/extractors/python_extractor.py
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CallRef, CodeSymbol, ExtractionResult } from '../../types';

/** Extract a Python docstring from a function/class body block.
 *  Docstrings are the first statement if it's an `expression_statement` whose child is a `string`. */
function extractDocstring(bodyNode: SyntaxNode | null): string | undefined {
  if (!bodyNode) return undefined;
  const first = bodyNode.namedChildren[0];
  if (!first || first.type !== 'expression_statement') return undefined;
  const strNode = first.namedChildren[0];
  if (!strNode || strNode.type !== 'string') return undefined;
  // Strip triple-quote delimiters and clean up
  const raw = strNode.text;
  const stripped = raw
    .replace(/^("""|''')\s?/, '')
    .replace(/\s?("""|''')$/, '');
  return stripped.trim() || undefined;
}

export function extractPython(rootNode: SyntaxNode): ExtractionResult {
  const symbols = walkNode(rootNode);
  return { symbols, language: 'python', rootNode };
}

function walkNode(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    if (child.type === 'class_definition') {
      const sym = extractClass(child);
      if (sym) symbols.push(sym);
    } else if (child.type === 'function_definition') {
      const sym = extractFunction(child);
      if (sym) symbols.push(sym);
    } else if (child.type === 'decorated_definition') {
      for (const sub of child.children) {
        if (sub.type === 'class_definition') {
          const sym = extractClass(sub);
          if (sym) symbols.push(sym);
        } else if (sub.type === 'function_definition') {
          const sym = extractFunction(sub);
          if (sym) symbols.push(sym);
        }
      }
    }
  }
  return symbols;
}

function extractClass(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const bodyNode = node.childForFieldName('body');
  const children = walkClassBody(node);
  const superclasses = extractBaseClasses(node);
  const docs = extractDocstring(bodyNode);
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
    docs,
  };
}

/** Extract base classes from Python class_definition's argument_list child.
 *  e.g., `class Admin(User, Mixin):` → ["User", "Mixin"] */
function extractBaseClasses(node: SyntaxNode): string[] {
  const bases: string[] = [];
  const argList = node.childForFieldName('superclasses');
  if (!argList) return bases;
  for (const child of argList.children) {
    if (child.type === 'identifier') {
      bases.push(child.text);
    } else if (child.type === 'attribute') {
      // e.g., module.ClassName — use the full dotted text
      bases.push(child.text);
    } else if (child.type === 'keyword_argument') {
      // Skip metaclass=... and other keyword args
    }
  }
  return bases;
}

function walkClassBody(node: SyntaxNode): CodeSymbol[] {
  const body = node.childForFieldName('body');
  if (!body) return [];
  const methods: CodeSymbol[] = [];
  for (const child of body.children) {
    if (child.type === 'function_definition') {
      const sym = extractFunction(child);
      if (sym) methods.push(sym);
    } else if (child.type === 'decorated_definition') {
      for (const sub of child.children) {
        if (sub.type === 'function_definition') {
          const sym = extractFunction(sub);
          if (sym) methods.push(sym);
        }
      }
    }
  }
  return methods;
}

function extractFunction(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName('parameters');
  const signature = paramsNode ? paramsNode.text : null;
  const paramTypes = paramsNode ? extractParamTypes(paramsNode) : null;
  const bodyNode = node.childForFieldName('body');
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  const docs = extractDocstring(bodyNode);
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
    paramTypes,
    docs,
  };
}

function extractParamTypes(
  paramsNode: SyntaxNode,
): Record<string, string> | null {
  const types: Record<string, string> = {};
  for (const child of paramsNode.children) {
    if (
      child.type === 'typed_parameter' ||
      child.type === 'typed_default_parameter'
    ) {
      // Name is the first identifier child (Python grammar has no "name" field)
      let nameNode: SyntaxNode | null = null;
      for (const sub of child.children) {
        if (sub.type === 'identifier') {
          nameNode = sub;
          break;
        }
      }
      const typeNode = child.childForFieldName('type');
      if (nameNode && typeNode) {
        const paramName = nameNode.text;
        if (paramName === 'self' || paramName === 'cls') continue;
        // Take the leaf of dotted types (e.g., grpc.Channel → Channel)
        const typeText = typeNode.text;
        const leaf = typeText.includes('.')
          ? typeText.split('.').pop()!
          : typeText;
        types[paramName] = leaf;
      }
    }
  }
  return Object.keys(types).length > 0 ? types : null;
}

function collectCalls(node: SyntaxNode): CallRef[] {
  const calls: CallRef[] = [];
  for (const child of node.children) {
    if (child.type === 'call') {
      const funcNode = child.childForFieldName('function');
      if (funcNode && funcNode.type === 'identifier') {
        calls.push({ name: funcNode.text, receiver: null, kind: 'bare' });
      } else if (funcNode && funcNode.type === 'attribute') {
        const objNode = funcNode.childForFieldName('object');
        const attrNode = funcNode.childForFieldName('attribute');
        if (objNode && attrNode) {
          calls.push({
            name: attrNode.text,
            receiver: objNode.text,
            kind: 'attribute',
          });
        }
      }
    }
    calls.push(...collectCalls(child));
  }
  return calls;
}
