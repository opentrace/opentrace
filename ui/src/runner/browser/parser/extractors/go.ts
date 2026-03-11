/**
 * Go symbol extractor using web-tree-sitter.
 * Ported from agent/src/opentrace_agent/sources/code/extractors/go_extractor.py
 */

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { CallRef, CodeSymbol, ExtractionResult } from "../../types";

export function extractGo(
  rootNode: SyntaxNode,
): ExtractionResult {
  const symbols = walkNode(rootNode);
  return { symbols, language: "go", rootNode };
}

function walkNode(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    if (child.type === "type_declaration") {
      const sym = extractTypeDecl(child);
      if (sym) symbols.push(sym);
    } else if (child.type === "function_declaration") {
      const sym = extractFunction(child);
      if (sym) symbols.push(sym);
    } else if (child.type === "method_declaration") {
      const sym = extractMethod(child);
      if (sym) symbols.push(sym);
    }
  }
  return symbols;
}

function extractTypeDecl(node: SyntaxNode): CodeSymbol | null {
  for (const child of node.children) {
    if (child.type === "type_spec") {
      const nameNode = child.childForFieldName("name");
      if (!nameNode) continue;
      const typeNode = child.childForFieldName("type");
      if (typeNode && (typeNode.type === "struct_type" || typeNode.type === "interface_type")) {
        const methods = typeNode.type === "interface_type"
          ? extractInterfaceMethods(typeNode)
          : [];
        return {
          name: nameNode.text,
          kind: "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          signature: null,
          children: methods,
          calls: [],
          receiverVar: null,
          receiverType: null,
        };
      }
    }
  }
  return null;
}

function extractInterfaceMethods(node: SyntaxNode): CodeSymbol[] {
  const methods: CodeSymbol[] = [];
  for (const child of node.children) {
    if (child.type === "method_elem") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        const paramsNode = child.childForFieldName("parameters");
        methods.push({
          name: nameNode.text,
          kind: "function",
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
          signature: paramsNode ? paramsNode.text : null,
          children: [],
          calls: [],
          receiverVar: null,
          receiverType: null,
        });
      }
    }
  }
  return methods;
}

function extractFunction(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName("parameters");
  const signature = paramsNode ? paramsNode.text : null;
  const bodyNode = node.childForFieldName("body");
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  return {
    name: nameNode.text,
    kind: "function",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar: null,
    receiverType: null,
  };
}

function extractMethod(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const paramsNode = node.childForFieldName("parameters");
  const receiverNode = node.childForFieldName("receiver");

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
  const signature = parts.length > 0 ? parts.join(" ") : null;

  const bodyNode = node.childForFieldName("body");
  const calls = bodyNode ? collectCalls(bodyNode) : [];
  return {
    name: nameNode.text,
    kind: "function",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    children: [],
    calls,
    receiverVar,
    receiverType,
  };
}

function parseReceiver(
  receiverNode: SyntaxNode,
): [string | null, string | null] {
  for (const child of receiverNode.children) {
    if (child.type === "parameter_declaration") {
      let varName: string | null = null;
      let typeName: string | null = null;
      const nameChild = child.childForFieldName("name");
      if (nameChild) varName = nameChild.text;
      const typeChild = child.childForFieldName("type");
      if (typeChild) {
        if (typeChild.type === "pointer_type") {
          for (const sub of typeChild.children) {
            if (sub.type === "type_identifier") {
              typeName = sub.text;
              break;
            }
          }
        } else if (typeChild.type === "type_identifier") {
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
    if (child.type === "call_expression") {
      const funcNode = child.childForFieldName("function");
      if (funcNode && funcNode.type === "identifier") {
        calls.push({ name: funcNode.text, receiver: null, kind: "bare" });
      } else if (funcNode && funcNode.type === "selector_expression") {
        const operand = funcNode.childForFieldName("operand");
        const field = funcNode.childForFieldName("field");
        if (operand && field) {
          calls.push({
            name: field.text,
            receiver: operand.text,
            kind: "attribute",
          });
        }
      }
    }
    calls.push(...collectCalls(child));
  }
  return calls;
}
