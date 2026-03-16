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
import { analyzeImports } from '../../runner/browser/parser/importAnalyzer';
import { summarizeFromMetadata } from '../../runner/browser/enricher/summarizer/templateSummarizer';
import type { NodeKind } from '../../runner/browser/enricher/summarizer/types';
import type {
  Registries,
  CallInfo,
} from '../../runner/browser/parser/callResolver';

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
  const dirChildNames = new Map<string, string[]>();

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

        // Summarize symbols inline using template summarizer
        const lines = file.content.split('\n');
        for (const node of nodes) {
          if (node.type !== 'Function' && node.type !== 'Class') continue;
          const startLine = node.properties?.start_line as number | undefined;
          const endLine = node.properties?.end_line as number | undefined;
          if (startLine == null || endLine == null) continue;
          const snippet = lines.slice(startLine - 1, endLine).join('\n');
          if (!snippet.trim()) continue;

          const kind: NodeKind = node.type === 'Class' ? 'class' : 'function';
          const summary = summarizeFromMetadata({
            name: node.name,
            kind,
            signature: node.properties?.signature as string | undefined,
            language,
            lineCount: endLine - startLine + 1,
            childNames:
              kind === 'class'
                ? extraction.symbols
                    .find((s) => s.name === node.name)
                    ?.children.map((c) => c.name)
                : undefined,
            receiverType: node.properties?.receiver_type as string | undefined,
            source: snippet,
            docs: node.properties?.docs as string | undefined,
          });
          if (summary) {
            node.properties = { ...node.properties, summary };
          }
        }

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

    // Summarize file node in-place (mutate the node from scanning stage)
    const fileName = file.path.includes('/')
      ? file.path.slice(file.path.lastIndexOf('/') + 1)
      : file.path;
    const symbolNames = nodes
      .filter((n) => n.type === 'Function' || n.type === 'Class')
      .map((n) => n.name);
    const fileSource = file.content.split('\n').slice(0, 200).join('\n');
    if (fileSource.trim()) {
      const fileSummary = summarizeFromMetadata({
        name: fileName,
        kind: 'file',
        fileName: file.path,
        language: language ?? undefined,
        childNames: symbolNames.length > 0 ? symbolNames : undefined,
        source: fileSource,
      });
      if (fileSummary) {
        // Emit summary-update node; store merges properties with the
        // original File node that was already saved by the scanning stage.
        nodes.push({
          id: fileId,
          type: 'File',
          name: fileName,
          properties: { summary: fileSummary },
        });
      }
    }

    // Track directory children for directory summaries later
    const dirPath = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : '';
    const parentDirId = dirPath ? `${repoId}/${dirPath}` : repoId;
    const names = dirChildNames.get(parentDirId) ?? [];
    names.push(fileName);
    dirChildNames.set(parentDirId, names);

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

  // Summarize non-parseable files (e.g. .md, .json, .css) that were skipped
  // by the main loop. Parseable files already have summaries.
  const summarizedFileIds = new Set<string>();
  // Collect IDs of files already summarized in the main loop
  for (const file of parseableFiles) {
    summarizedFileIds.add(`${repoId}/${file.path}`);
  }
  const nonParseableFileSummaryNodes: GraphNode[] = [];
  for (const fileNode of input.fileNodes) {
    if (summarizedFileIds.has(fileNode.id)) continue;
    const fileName = fileNode.name;
    const filePath = (fileNode.properties?.path as string) || fileName;
    const summary = summarizeFromMetadata({
      name: fileName,
      kind: 'file',
      fileName: filePath,
    });
    if (summary) {
      nonParseableFileSummaryNodes.push({
        id: fileNode.id,
        type: 'File',
        name: fileName,
        properties: { summary },
      });
    }
    // Track as directory child so directory summaries include all files
    const dirPath = filePath.includes('/')
      ? filePath.slice(0, filePath.lastIndexOf('/'))
      : '';
    const parentDirId = dirPath ? `${repoId}/${dirPath}` : repoId;
    const names = dirChildNames.get(parentDirId) ?? [];
    names.push(fileName);
    dirChildNames.set(parentDirId, names);
  }
  if (nonParseableFileSummaryNodes.length > 0) {
    yield {
      kind: 'stage_progress',
      phase: 'processing',
      message: `Summarized ${nonParseableFileSummaryNodes.length} non-parseable files`,
      detail: { current: total, total },
      nodes: nonParseableFileSummaryNodes,
    };
  }

  // Summarize directories — emit update nodes (store merges properties)
  const dirSummaryNodes: GraphNode[] = [];
  for (const [dirId, dirNode] of input.dirNodes) {
    const dirPath = (dirNode.properties?.path as string) || dirNode.name;
    const childNames = [...(dirChildNames.get(dirId) ?? [])];
    // Include subdirectories
    for (const [otherId, otherNode] of input.dirNodes) {
      const otherPath = (otherNode.properties?.path as string) || '';
      const otherParent = otherPath.includes('/')
        ? otherPath.slice(0, otherPath.lastIndexOf('/'))
        : '';
      if (otherParent === dirPath && otherId !== dirId) {
        childNames.push(otherNode.name + '/');
      }
    }
    if (childNames.length > 0) {
      const summary = summarizeFromMetadata({
        name: dirNode.name,
        kind: 'directory',
        childNames,
      });
      if (summary) {
        dirSummaryNodes.push({
          id: dirId,
          type: 'Directory',
          name: dirNode.name,
          properties: { summary },
        });
      }
    }
  }

  yield {
    kind: 'stage_stop',
    phase: 'processing',
    message: `Processed ${filesProcessed} files`,
    errors: errors.length > 0 ? errors : undefined,
    nodes: dirSummaryNodes.length > 0 ? dirSummaryNodes : undefined,
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
