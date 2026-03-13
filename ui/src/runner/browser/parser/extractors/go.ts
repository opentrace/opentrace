/**
 * Go symbol extractor using web-tree-sitter.
 * Ported from agent/src/opentrace_agent/sources/code/extractors/go_extractor.py
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { CallRef, CodeSymbol, ExtractionResult } from '../../types';

/** Extract GoDoc comments from consecutive preceding `comment` siblings.
 *  Go convention: `// Comment` lines immediately above a declaration. */
function extractGoDoc(node: SyntaxNode): string | undefined {
  const comments: string[] = [];
  let prev = node.previousNamedSibling;
  while (prev && prev.type === 'comment') {
    comments.push(prev.text);
    prev = prev.previousNamedSibling;
  }
  if (comments.length === 0) return undefined;
  // Reverse (we collected bottom-up) and strip `// ` prefix
  const cleaned = comments
    .reverse()
    .map((line) => line.replace(/^\/\/\s?/, ''))
    .join('\n')
    .trim();
  return cleaned || undefined;
}

export function extractGo(rootNode: SyntaxNode): ExtractionResult {
  const symbols = walkNode(rootNode);
  return { symbols, language: 'go', rootNode };
}

function walkNode(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    let sym: CodeSymbol | null = null;
    if (child.type === 'type_declaration') {
      sym = extractTypeDecl(child);
    } else if (child.type === 'function_declaration') {
      sym = extractFunction(child);
    } else if (child.type === 'method_declaration') {
      sym = extractMethod(child);
    }
    if (sym) {
      sym.docs = extractGoDoc(child);
      symbols.push(sym);
    }
  }
  return symbols;
}

function extractTypeDecl(node: SyntaxNode): CodeSymbol | null {
  for (const child of node.children) {
    if (child.type === 'type_spec') {
      const nameNode = child.childForFieldName('name');
      if (!nameNode) continue;
      const typeNode = child.childForFieldName('type');
      if (
        typeNode &&
        (typeNode.type === 'struct_type' || typeNode.type === 'interface_type')
      ) {
        const isInterface = typeNode.type === 'interface_type';
        const methods = isInterface ? extractInterfaceMethods(typeNode) : [];
        const subtype = isInterface ? 'interface' : 'struct';
        const embedded = isInterface
          ? extractEmbeddedInterfaces(typeNode)
          : extractEmbeddedStructs(typeNode);
        return {
          name: nameNode.text,
          kind: 'class',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: null,
          children: methods,
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
          subtype,
          interfaces: isInterface && embedded.length > 0 ? embedded : undefined,
          superclasses:
            !isInterface && embedded.length > 0 ? embedded : undefined,
        };
      }
    }
  }
  return null;
}

/** Extract embedded interface names from interface_type children.
 *  e.g., `type ReadWriter interface { Reader; Writer }` → ["Reader", "Writer"]
 *  Embedded interfaces appear as type_elem → type_identifier (not method_elem). */
function extractEmbeddedInterfaces(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of node.children) {
    if (child.type === 'type_elem') {
      for (const sub of child.children) {
        if (sub.type === 'type_identifier') {
          names.push(sub.text);
        } else if (sub.type === 'qualified_type') {
          names.push(sub.text);
        }
      }
    }
  }
  return names;
}

/** Extract embedded struct field types from struct_type children.
 *  e.g., `type Admin struct { User }` → ["User"] */
function extractEmbeddedStructs(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (const child of node.children) {
    if (child.type === 'field_declaration_list') {
      for (const field of child.children) {
        if (field.type === 'field_declaration') {
          // Embedded fields have a type but no name
          const nameNode = field.childForFieldName('name');
          const typeNode = field.childForFieldName('type');
          if (!nameNode && typeNode) {
            if (typeNode.type === 'type_identifier') {
              names.push(typeNode.text);
            } else if (typeNode.type === 'pointer_type') {
              for (const sub of typeNode.children) {
                if (sub.type === 'type_identifier') {
                  names.push(sub.text);
                  break;
                }
              }
            } else if (typeNode.type === 'qualified_type') {
              names.push(typeNode.text);
            }
          }
        }
      }
    }
  }
  return names;
}

function extractInterfaceMethods(node: SyntaxNode): CodeSymbol[] {
  const methods: CodeSymbol[] = [];
  for (const child of node.children) {
    if (child.type === 'method_elem') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        const paramsNode = child.childForFieldName('parameters');
        methods.push({
          name: nameNode.text,
          kind: 'function',
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: paramsNode ? paramsNode.text : null,
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
          paramTypes: null,
        });
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
  const receiverNode = node.childForFieldName('receiver');

  const parts: string[] = [];
  let receiverVar: string | null = null;
  let receiverType: string | null = null;
  if (receiverNode) {
    parts.push(receiverNode.text);
    [receiverVar, receiverType] = parseReceiver(receiverNode);
  }
  if (paramsNode) {
    parts.push(paramsNode.text);
  }
  const signature = parts.length > 0 ? parts.join(' ') : null;

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
    receiverVar,
    receiverType,
    paramTypes: null,
  };
}

function parseReceiver(
  receiverNode: SyntaxNode,
): [string | null, string | null] {
  for (const child of receiverNode.children) {
    if (child.type === 'parameter_declaration') {
      let varName: string | null = null;
      let typeName: string | null = null;
      const nameChild = child.childForFieldName('name');
      if (nameChild) varName = nameChild.text;
      const typeChild = child.childForFieldName('type');
      if (typeChild) {
        if (typeChild.type === 'pointer_type') {
          for (const sub of typeChild.children) {
            if (sub.type === 'type_identifier') {
              typeName = sub.text;
              break;
            }
          }
        } else if (typeChild.type === 'type_identifier') {
          typeName = typeChild.text;
        }
      }
      return [varName, typeName];
    }
  }
  return [null, null];
}

function collectCalls(node: SyntaxNode): CallRef[] {
  const calls: CallRef[] = [];
  for (const child of node.children) {
    if (child.type === 'call_expression') {
      const funcNode = child.childForFieldName('function');
      if (funcNode && funcNode.type === 'identifier') {
        calls.push({ name: funcNode.text, receiver: null, kind: 'bare' });
      } else if (funcNode && funcNode.type === 'selector_expression') {
        const operand = funcNode.childForFieldName('operand');
        const field = funcNode.childForFieldName('field');
        if (operand && field) {
          calls.push({
            name: field.text,
            receiver: operand.text,
            kind: 'attribute',
          });
        }
      }
    }
    calls.push(...collectCalls(child));
  }
  return calls;
}
