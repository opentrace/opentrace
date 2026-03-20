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
 * Processing stage: per-file parsing + symbol extraction + import analysis.
 *
 * For each parseable file:
 * 1. Parse with tree-sitter
 * 2. Extract symbols → Class/Function nodes + DEFINED_IN rels
 * 3. Populate registries + allCallInfo
 * 4. Analyze imports → IMPORTS rels + Package nodes
 * 5. Yield per-file nodes/rels as stage_progress
 *
 * rootNode is used immediately and discarded (no Map accumulation).
 */

import type {
  ExtractionResult,
  GraphNode,
  GraphRelationship,
  ScanResult,
  ProcessingOutput,
  PipelineContext,
  PipelineEvent,
} from '../types';
import { detectLanguage, getExtension } from './loading';
import {
  getExtractor,
  getParserForLanguage,
  processSymbol,
  countSymbols,
} from './parsing';
import { analyzeImports } from '../parser/importAnalyzer';
import type { Registries, CallInfo } from '../parser/callResolver';

export function* execute(
  input: ScanResult,
  ctx: PipelineContext,
): Generator<PipelineEvent, ProcessingOutput> {
  const { parseableFiles, repoId, knownPaths, pathToFileId, goModulePath } =
    input;
  const total = parseableFiles.length;

  yield {
    kind: 'stage_start',
    phase: 'processing',
    message: `Processing ${total} files`,
  };

  // Initialize registries
  const registries: Registries = {
    nameRegistry: new Map(),
    fileRegistry: new Map(),
    classRegistry: new Map(),
    importRegistry: new Map(),
  };
  const allCallInfo: CallInfo[] = [];
  const emittedNodeIds = new Set<string>();

  // Copy package nodes from scanning (will accumulate more from imports)
  const packageNodes = new Map(input.packageNodes);

  const structureNodes: GraphNode[] = [
    input.repoNode,
    ...input.dirNodes.values(),
    ...input.fileNodes,
    ...input.packageNodes.values(),
  ];
  let totalNodes = structureNodes.length;
  let totalRels = input.structureRels.length + input.dependencyRels.length;
  let filesProcessed = 0;
  let classesExtracted = 0;
  let functionsExtracted = 0;
  const errors: string[] = [];

  for (let i = 0; i < parseableFiles.length; i++) {
    if (ctx.cancelled) break;

    const file = parseableFiles[i];
    const ext = getExtension(file.path);
    const language = detectLanguage(ext);
    const fileId = `${repoId}/${file.path}`;

    if (!language) {
      filesProcessed++;
      continue;
    }

    const parser = getParserForLanguage(language, ext);
    const extractor = getExtractor(language);

    if (!parser || !extractor) {
      filesProcessed++;
      yield {
        kind: 'stage_progress',
        phase: 'processing',
        message: `Processing ${file.path}`,
        detail: { current: i + 1, total, fileName: file.path },
      };
      continue;
    }

    let extraction: ExtractionResult | null = null;
    const nodes: GraphNode[] = [];
    const rels: GraphRelationship[] = [];

    try {
      const tree = parser.parse(file.content);
      if (!tree) {
        errors.push(`${file.path}: parse returned null`);
      } else {
        extraction = extractor(tree.rootNode);

        // Initialize file registry entry
        registries.fileRegistry.set(fileId, new Map());

        // Process symbols → graph nodes + registries
        for (const sym of extraction.symbols) {
          processSymbol(
            sym,
            fileId,
            language,
            registries,
            allCallInfo,
            nodes,
            rels,
            emittedNodeIds,
          );
        }
        const symCounts = countSymbols(extraction.symbols);
        classesExtracted += symCounts.classes;
        functionsExtracted += symCounts.functions;

        // Import analysis — uses rootNode immediately, then discards it
        const rootNode = extraction.rootNode;
        if (rootNode) {
          const importResult = analyzeImports(
            rootNode,
            language,
            file.path,
            knownPaths,
            goModulePath,
          );

          // Internal imports → populate importRegistry + IMPORTS edges
          const fileImports: Record<string, string> = {};
          const seenTargetFiles = new Set<string>();
          for (const [alias, targetPath] of Object.entries(
            importResult.internal,
          )) {
            const targetFileId = pathToFileId.get(targetPath);
            if (targetFileId) {
              fileImports[alias] = targetFileId;
              if (!seenTargetFiles.has(targetFileId)) {
                seenTargetFiles.add(targetFileId);
                rels.push({
                  id: `${fileId}->IMPORTS->${targetFileId}`,
                  type: 'IMPORTS',
                  source_id: fileId,
                  target_id: targetFileId,
                });
              }
            }
          }
          registries.importRegistry.set(fileId, fileImports);

          // External imports → IMPORTS rels + new Package nodes
          for (const [pkgName, pkgId] of Object.entries(
            importResult.external,
          )) {
            if (!packageNodes.has(pkgId)) {
              const pkgNode: GraphNode = {
                id: pkgId,
                type: 'Package',
                name: pkgName,
                properties: { registry: pkgId.split(':')[1] },
              };
              packageNodes.set(pkgId, pkgNode);
              nodes.push(pkgNode);
            }

            rels.push({
              id: `${fileId}->IMPORTS->${pkgId}`,
              type: 'IMPORTS',
              source_id: fileId,
              target_id: pkgId,
            });
          }
        }
        // rootNode is not stored — used above and now eligible for GC
      }
    } catch (err) {
      errors.push(
        `${file.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    totalNodes += nodes.length;
    totalRels += rels.length;
    filesProcessed++;

    yield {
      kind: 'stage_progress',
      phase: 'processing',
      message: `Processing ${file.path}`,
      detail: { current: i + 1, total, fileName: file.path },
      nodes: nodes.length > 0 ? nodes : undefined,
      relationships: rels.length > 0 ? rels : undefined,
    };
  }

  yield {
    kind: 'stage_stop',
    phase: 'processing',
    message: `Processed ${filesProcessed} files`,
    errors: errors.length > 0 ? errors : undefined,
  };

  return {
    scanResult: input,
    registries,
    allCallInfo,
    packageNodes,
    stats: {
      nodesCreated: totalNodes,
      relationshipsCreated: totalRels,
      filesProcessed,
      classesExtracted,
      functionsExtracted,
    },
  };
}
