/**
 * Python symbol extractor using web-tree-sitter.
 * Ported from agent/src/opentrace_agent/sources/code/extractors/python_extractor.py
 */

import type { Node as SyntaxNode } from "web-tree-sitter";
import type { CallRef, CodeSymbol, ExtractionResult } from "../../types";

export function extractPython(
  rootNode: SyntaxNode,
): ExtractionResult {
  const symbols = walkNode(rootNode);
  return { symbols, language: "python", rootNode };
}

function walkNode(node: SyntaxNode): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (const child of node.children) {
    if (child.type === "class_definition") {
      const sym = extractClass(child);
      if (sym) symbols.push(sym);
    } else if (child.type === "function_definition") {
      const sym = extractFunction(child);
      if (sym) symbols.push(sym);
    } else if (child.type === "decorated_definition") {
      for (const sub of child.children) {
        if (sub.type === "class_definition") {
          const sym = extractClass(sub);
          if (sym) symbols.push(sym);
        } else if (sub.type === "function_definition") {
          const sym = extractFunction(sub);
          if (sym) symbols.push(sym);
        }
      }
    }
  }
  return symbols;
}

function extractClass(node: SyntaxNode): CodeSymbol | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  const children = walkClassBody(node);
  return {
    name: nameNode.text,
    kind: "class",
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: null,
    children,
    calls: [],
    receiverVar: null,
    receiverType: null,
  };
}

function walkClassBody(node: SyntaxNode): CodeSymbol[] {
  const body = node.childForFieldName("body");
  if (!body) return [];
  const methods: CodeSymbol[] = [];
  for (const child of body.children) {
    if (child.type === "function_definition") {
      const sym = extractFunction(child);
      if (sym) methods.push(sym);
    } else if (child.type === "decorated_definition") {
      for (const sub of child.children) {
        if (sub.type === "function_definition") {
          const sym = extractFunction(sub);
          if (sym) methods.push(sym);
        }
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

function collectCalls(node: SyntaxNode): CallRef[] {
  const calls: CallRef[] = [];
  for (const child of node.children) {
    if (child.type === "call") {
      const funcNode = child.childForFieldName("function");
      if (funcNode && funcNode.type === "identifier") {
        calls.push({ name: funcNode.text, receiver: null, kind: "bare" });
      } else if (funcNode && funcNode.type === "attribute") {
        const objNode = funcNode.childForFieldName("object");
        const attrNode = funcNode.childForFieldName("attribute");
        if (objNode && attrNode) {
          calls.push({
            name: attrNode.text,
            receiver: objNode.text,
            kind: "attribute",
          });
        }
      }
    }
    calls.push(...collectCalls(child));
  }
  return calls;
}
