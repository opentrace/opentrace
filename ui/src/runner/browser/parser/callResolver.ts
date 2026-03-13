/**
 * 7-strategy call resolution for resolving CallRef → target node.
 * Ported from agent/src/opentrace_agent/sources/code/symbol_attacher.py _resolve_calls/_resolve_single_call
 *
 * Resolution priority:
 *   1. self/this → enclosing class children
 *   2. Go receiver var → methods with matching receiver_type
 *   3. ClassName.method() → class_registry lookup
 *   4. Import-based resolution → alias maps to target file
 *   5. Constructor call → bare name matches class
 *   6. Intra-file bare call
 *   7. Cross-file bare call with unique match
 */

import type { CallRef, GraphRelationship } from '../types';

/** Internal node representation for resolution (before converting to graph nodes). */
export interface SymbolNode {
  id: string;
  name: string;
  kind: 'class' | 'function';
  fileId: string;
  parentId: string;
  receiverVar: string | null;
  receiverType: string | null;
  paramTypes: Record<string, string> | null;
  children: SymbolNode[];
}

/** Registries populated during Phase 1 (extraction). */
export interface Registries {
  /** name → all nodes with that name */
  nameRegistry: Map<string, SymbolNode[]>;
  /** fileId → { symbolName → node } */
  fileRegistry: Map<string, Map<string, SymbolNode>>;
  /** className → class nodes (multiple classes can share a name across files) */
  classRegistry: Map<string, SymbolNode[]>;
  /** fileId → { alias → targetFileId } */
  importRegistry: Map<string, Record<string, string>>;
}

export interface CallInfo {
  callerNode: SymbolNode;
  calls: CallRef[];
  fileId: string;
}

export interface ResolvedCall {
  sourceId: string;
  targetId: string;
  confidence: number;
}

/** Resolve all collected calls and return relationships. */
export function resolveCalls(
  callInfos: CallInfo[],
  registries: Registries,
): ResolvedCall[] {
  const results: ResolvedCall[] = [];

  for (const { callerNode, calls, fileId } of callInfos) {
    const seen = new Set<string>();

    for (const ref of calls) {
      const dedupKey = `${ref.receiver ?? ''}:${ref.name}`;
      if (seen.has(dedupKey)) continue;
      // Skip self-recursive calls
      if (ref.name === callerNode.name && ref.receiver === null) continue;

      const resolved = resolveSingleCall(ref, callerNode, fileId, registries);
      if (!resolved) continue;

      seen.add(dedupKey);
      results.push({
        sourceId: callerNode.id,
        targetId: resolved.targetId,
        confidence: resolved.confidence,
      });
    }
  }

  return results;
}

function resolveSingleCall(
  ref: CallRef,
  callerNode: SymbolNode,
  fileId: string,
  registries: Registries,
): { targetId: string; confidence: number } | null {
  const { nameRegistry, fileRegistry, classRegistry, importRegistry } =
    registries;

  // Strategy 1: self/this resolution
  if (
    ref.kind === 'attribute' &&
    (ref.receiver === 'self' || ref.receiver === 'this')
  ) {
    const classNode = findEnclosingClass(callerNode, classRegistry);
    if (classNode) {
      for (const child of classNode.children) {
        if (child.name === ref.name) {
          return { targetId: child.id, confidence: 1.0 };
        }
      }
    }
    return null;
  }

  // Strategy 2: Go receiver variable resolution
  if (ref.kind === 'attribute') {
    if (
      callerNode.receiverVar &&
      ref.receiver === callerNode.receiverVar &&
      callerNode.receiverType
    ) {
      const candidates = nameRegistry.get(ref.name) ?? [];
      for (const candidate of candidates) {
        if (candidate.receiverType === callerNode.receiverType) {
          return { targetId: candidate.id, confidence: 1.0 };
        }
      }
    }
  }

  // Strategy 2.5: Parameter type hint resolution (param.method() where param has a known type)
  if (ref.kind === 'attribute' && ref.receiver && callerNode.paramTypes) {
    const typeName = callerNode.paramTypes[ref.receiver];
    if (typeName && classRegistry.has(typeName)) {
      const classCandidates = classRegistry.get(typeName)!;
      for (const cls of classCandidates) {
        for (const child of cls.children) {
          if (child.name === ref.name) {
            return { targetId: child.id, confidence: 0.7 };
          }
        }
      }
    }
  }

  // Strategy 3: ClassName.method() resolution
  if (
    ref.kind === 'attribute' &&
    ref.receiver &&
    classRegistry.has(ref.receiver)
  ) {
    const classCandidates = classRegistry.get(ref.receiver)!;
    // Prefer same-file class, then fall back to any
    const sorted = [...classCandidates].sort(
      (a, b) => (a.fileId === fileId ? 0 : 1) - (b.fileId === fileId ? 0 : 1),
    );
    for (const cls of sorted) {
      for (const child of cls.children) {
        if (child.name === ref.name) {
          const targetFileId = child.id.split('::')[0];
          const conf = targetFileId === fileId ? 1.0 : 0.9;
          return { targetId: child.id, confidence: conf };
        }
      }
    }
    // Also check Go-style methods (not class children but have matching receiver_type)
    const candidates = nameRegistry.get(ref.name) ?? [];
    for (const candidate of candidates) {
      if (candidate.receiverType === ref.receiver) {
        const targetFileId = candidate.id.split('::')[0];
        const conf = targetFileId === fileId ? 1.0 : 0.9;
        return { targetId: candidate.id, confidence: conf };
      }
    }
    return null;
  }

  // Strategy 4: Import-based resolution
  if (ref.kind === 'attribute' && ref.receiver) {
    const fileImports = importRegistry.get(fileId);
    if (fileImports) {
      const targetFileId = fileImports[ref.receiver];
      if (targetFileId) {
        const targetNames = fileRegistry.get(targetFileId);
        if (targetNames) {
          const target = targetNames.get(ref.name);
          if (target) {
            return { targetId: target.id, confidence: 0.9 };
          }
        }
      }
    }
  }

  // Strategy 4.5: Import-based bare call resolution (from X import Y → Y())
  if (ref.kind === 'bare') {
    const fileImports = importRegistry.get(fileId);
    if (fileImports) {
      const targetFileId = fileImports[ref.name];
      if (targetFileId) {
        const targetNames = fileRegistry.get(targetFileId);
        if (targetNames) {
          const target = targetNames.get(ref.name);
          if (target) {
            // If it's a class, prefer its __init__/constructor
            if (target.kind === 'class') {
              for (const child of target.children) {
                if (child.name === '__init__' || child.name === 'constructor') {
                  return { targetId: child.id, confidence: 0.9 };
                }
              }
            }
            return { targetId: target.id, confidence: 0.9 };
          }
        }
      }
    }
  }

  // Strategy 5: Constructor call — bare name matches a class
  if (ref.kind === 'bare' && classRegistry.has(ref.name)) {
    const classCandidates = classRegistry.get(ref.name)!;
    // Prefer same-file class, then fall back to any
    const sorted = [...classCandidates].sort(
      (a, b) => (a.fileId === fileId ? 0 : 1) - (b.fileId === fileId ? 0 : 1),
    );
    for (const cls of sorted) {
      // Try to find __init__ or constructor child
      for (const child of cls.children) {
        if (child.name === '__init__' || child.name === 'constructor') {
          const targetFileId = child.id.split('::')[0];
          const conf = targetFileId === fileId ? 1.0 : 0.8;
          return { targetId: child.id, confidence: conf };
        }
      }
    }
    // Fall back to the class node itself (prefer same-file)
    const cls = sorted[0];
    const targetFileId = cls.id.split('::')[0];
    const conf = targetFileId === fileId ? 1.0 : 0.8;
    return { targetId: cls.id, confidence: conf };
  }

  // Strategy 6: Intra-file bare call
  if (ref.kind === 'bare') {
    const fileNames = fileRegistry.get(fileId);
    if (fileNames) {
      const target = fileNames.get(ref.name);
      if (target) {
        return { targetId: target.id, confidence: 1.0 };
      }
    }
  }

  // Strategy 7: Cross-file bare call (unique match only)
  if (ref.kind === 'bare') {
    const candidates = nameRegistry.get(ref.name) ?? [];
    const crossFile = candidates.filter((c) => c.id.split('::')[0] !== fileId);
    if (crossFile.length === 1) {
      return { targetId: crossFile[0].id, confidence: 0.8 };
    }
  }

  return null;
}

function findEnclosingClass(
  node: SymbolNode,
  classRegistry: Map<string, SymbolNode[]>,
): SymbolNode | null {
  // Walk up the ID to find the class — IDs are structured as fileId::ClassName::methodName
  const parts = node.id.split('::');
  // Try progressively shorter prefixes to find a class
  for (let i = parts.length - 1; i >= 1; i--) {
    const potentialClassName = parts[i];
    const candidates = classRegistry.get(potentialClassName);
    if (candidates) {
      for (const cls of candidates) {
        // Verify this class is actually an ancestor (its ID is a prefix of node's ID)
        if (node.id.startsWith(cls.id + '::')) {
          return cls;
        }
      }
    }
  }
  return null;
}

/** Convert resolved calls into GraphRelationship objects. */
export function resolvedCallsToRelationships(
  resolvedCalls: ResolvedCall[],
): GraphRelationship[] {
  return resolvedCalls.map((call) => ({
    id: `${call.sourceId}->CALLS->${call.targetId}`,
    type: 'CALLS',
    source_id: call.sourceId,
    target_id: call.targetId,
    properties: { confidence: call.confidence },
  }));
}
