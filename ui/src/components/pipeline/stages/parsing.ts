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

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type {
  CodeSymbol,
  ExtractionResult,
  GraphNode,
  GraphRelationship,
  ParserMap,
  ParsingFileResult,
} from '../types';
import { detectLanguage, getExtension } from './loading';
import { extractPython } from '../parser/extractors/python';
import { extractTypeScript } from '../parser/extractors/typescript';
import { extractGo } from '../parser/extractors/go';
import { extractGeneric } from '../parser/extractors/generic';
import type { Registries, CallInfo, SymbolNode } from '../parser/callResolver';

// --- Parser registry (module-level) ---

let parsers: ParserMap = new Map();

/** Register parsers for use by the parsing stage. Call once during init. */
export function initParsers(map: ParserMap): void {
  parsers = map;
}

export function getExtractor(
  language: string,
): ((rootNode: SyntaxNode) => ExtractionResult) | null {
  switch (language) {
    case 'python':
      return extractPython;
    case 'typescript':
    case 'javascript':
      return (rootNode) => extractTypeScript(rootNode, language);
    case 'go':
      return extractGo;
    case 'c':
    case 'cpp':
    case 'csharp':
    case 'java':
    case 'kotlin':
    case 'ruby':
    case 'rust':
    case 'swift':
      return (rootNode) => extractGeneric(rootNode, language);
    default:
      return null;
  }
}

export function getParserForLanguage(language: string, ext: string) {
  if (language === 'typescript' && ext === '.tsx') {
    return parsers.get('tsx') ?? parsers.get('typescript');
  }
  if (language === 'javascript' && ext === '.jsx') {
    return parsers.get('jsx') ?? parsers.get('javascript');
  }
  return parsers.get(language);
}

export function parseFile(
  filePath: string,
  fileContent: string,
  repoId: string,
): ParsingFileResult {
  const ext = getExtension(filePath);
  const language = detectLanguage(ext);

  if (!language) {
    return {
      nodes: [],
      relationships: [],
      classesExtracted: 0,
      functionsExtracted: 0,
    };
  }

  const parser = getParserForLanguage(language, ext);
  if (!parser) {
    return {
      nodes: [],
      relationships: [],
      classesExtracted: 0,
      functionsExtracted: 0,
    };
  }

  const extractor = getExtractor(language);
  if (!extractor) {
    return {
      nodes: [],
      relationships: [],
      classesExtracted: 0,
      functionsExtracted: 0,
    };
  }

  try {
    const tree = parser.parse(fileContent);
    if (!tree) {
      return {
        nodes: [],
        relationships: [],
        classesExtracted: 0,
        functionsExtracted: 0,
        error: `${filePath}: parse returned null`,
      };
    }

    const result = extractor(tree.rootNode);
    const fileId = `${repoId}/${filePath}`;
    const nodes: GraphNode[] = [];
    const rels: GraphRelationship[] = [];
    const stats = { classesExtracted: 0, functionsExtracted: 0 };

    for (const sym of result.symbols) {
      convertSymbol(sym, fileId, nodes, rels, stats);
    }

    return { nodes, relationships: rels, ...stats };
  } catch (err) {
    return {
      nodes: [],
      relationships: [],
      classesExtracted: 0,
      functionsExtracted: 0,
      error: `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Process a symbol into graph nodes/rels and populate registries for call resolution.
 * Ported from runner's pipeline.ts processSymbol().
 */
export function processSymbol(
  symbol: CodeSymbol,
  parentId: string,
  language: string,
  registries: Registries,
  callInfos: CallInfo[],
  nodes: GraphNode[],
  rels: GraphRelationship[],
  emittedNodeIds: Set<string>,
): SymbolNode | null {
  const fileId = parentId.split('::')[0];
  const sig = symbol.typeSignature ?? '';
  const namePart = symbol.receiverType
    ? `${symbol.receiverType}.${symbol.name}${sig}`
    : `${symbol.name}${sig}`;
  const nodeId = `${parentId}::${namePart}`;

  // Guard against duplicate node IDs (e.g. C++ constructors sharing class name)
  if (emittedNodeIds.has(nodeId)) {
    return null;
  }
  emittedNodeIds.add(nodeId);

  if (symbol.kind === 'class') {
    const props: Record<string, unknown> = {
      language,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
    };
    if (symbol.signature) props.signature = symbol.signature;
    if (symbol.superclasses) props.superclasses = symbol.superclasses;
    if (symbol.interfaces) props.interfaces = symbol.interfaces;
    if (symbol.subtype) props.kind = symbol.subtype;
    if (symbol.docs) props.docs = symbol.docs;

    nodes.push({
      id: nodeId,
      type: 'Class',
      name: symbol.name,
      properties: props,
    });

    rels.push({
      id: `${parentId}->DEFINES->${nodeId}`,
      type: 'DEFINES',
      source_id: parentId,
      target_id: nodeId,
    });

    const symbolNode: SymbolNode = {
      id: nodeId,
      name: symbol.name,
      kind: 'class',
      fileId,
      parentId,
      receiverVar: null,
      receiverType: null,
      paramTypes: null,
      children: [],
    };
    addToRegistry(registries.nameRegistry, symbol.name, symbolNode);
    registries.fileRegistry.get(fileId)?.set(symbol.name, symbolNode);
    addToRegistry(registries.classRegistry, symbol.name, symbolNode);

    for (const child of symbol.children) {
      const childSymbolNode = processSymbol(
        child,
        nodeId,
        language,
        registries,
        callInfos,
        nodes,
        rels,
        emittedNodeIds,
      );
      if (childSymbolNode) symbolNode.children.push(childSymbolNode);
    }

    return symbolNode;
  } else {
    const props: Record<string, unknown> = {
      language,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
    };
    if (symbol.signature) props.signature = symbol.signature;
    if (symbol.typeSignature) props.typeSignature = symbol.typeSignature;
    if (symbol.returnType) props.returnType = symbol.returnType;
    if (symbol.docs) props.docs = symbol.docs;

    const displaySig = symbol.typeSignature ?? symbol.signature ?? '';
    const displayName = displaySig
      ? `${symbol.name}${displaySig}`
      : symbol.name;

    nodes.push({
      id: nodeId,
      type: 'Function',
      name: displayName,
      properties: props,
    });

    rels.push({
      id: `${parentId}->DEFINES->${nodeId}`,
      type: 'DEFINES',
      source_id: parentId,
      target_id: nodeId,
    });

    const symbolNode: SymbolNode = {
      id: nodeId,
      name: symbol.name,
      kind: 'function',
      fileId,
      parentId,
      receiverVar: symbol.receiverVar,
      receiverType: symbol.receiverType,
      paramTypes: symbol.paramTypes,
      children: [],
    };
    addToRegistry(registries.nameRegistry, symbol.name, symbolNode);
    registries.fileRegistry.get(fileId)?.set(symbol.name, symbolNode);

    if (symbol.calls.length > 0) {
      callInfos.push({
        callerNode: symbolNode,
        calls: symbol.calls,
        fileId,
      });
    }

    return symbolNode;
  }
}

export function addToRegistry(
  registry: Map<string, SymbolNode[]>,
  name: string,
  node: SymbolNode,
): void {
  const existing = registry.get(name);
  if (existing) {
    existing.push(node);
  } else {
    registry.set(name, [node]);
  }
}

/** Recursively count classes and functions (including methods inside classes). */
export function countSymbols(symbols: CodeSymbol[]): {
  classes: number;
  functions: number;
} {
  let classes = 0;
  let functions = 0;
  for (const sym of symbols) {
    if (sym.kind === 'class') {
      classes++;
      const childCounts = countSymbols(sym.children);
      classes += childCounts.classes;
      functions += childCounts.functions;
    } else {
      functions++;
    }
  }
  return { classes, functions };
}

function convertSymbol(
  sym: CodeSymbol,
  parentId: string,
  nodes: GraphNode[],
  rels: GraphRelationship[],
  stats: { classesExtracted: number; functionsExtracted: number },
): void {
  const sig = sym.typeSignature ?? '';
  const namePart = sym.receiverType
    ? `${sym.receiverType}.${sym.name}${sig}`
    : `${sym.name}${sig}`;
  const symId = `${parentId}::${namePart}`;
  const nodeType = sym.kind === 'class' ? 'Class' : 'Function';

  const props: Record<string, unknown> = {
    startLine: sym.startLine,
    endLine: sym.endLine,
  };
  if (sym.signature) props.signature = sym.signature;
  if (sym.kind === 'function' && sym.typeSignature) {
    props.typeSignature = sym.typeSignature;
  }
  if (sym.kind === 'function' && sym.returnType) {
    props.returnType = sym.returnType;
  }
  if (sym.docs) props.docs = sym.docs;
  if (sym.superclasses) props.superclasses = sym.superclasses;
  if (sym.interfaces) props.interfaces = sym.interfaces;
  if (sym.subtype) props.kind = sym.subtype;

  const displaySig =
    sym.kind === 'function'
      ? (sym.typeSignature ?? sym.signature ?? '')
      : '';
  const displayName = displaySig
    ? `${sym.name}${displaySig}`
    : sym.name;

  nodes.push({
    id: symId,
    type: nodeType,
    name: displayName,
    properties: props,
  });

  rels.push({
    id: `${parentId}->DEFINES->${symId}`,
    type: 'DEFINES',
    source_id: parentId,
    target_id: symId,
  });

  if (sym.kind === 'class') {
    stats.classesExtracted++;
    for (const child of sym.children) {
      // Skip constructors that share the class name to avoid duplicate IDs
      if (child.kind === 'function' && child.name === sym.name) continue;
      convertSymbol(child, symId, nodes, rels, stats);
    }
  } else {
    stats.functionsExtracted++;
  }
}
