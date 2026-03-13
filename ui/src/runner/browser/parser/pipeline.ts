/**
 * Full indexing pipeline: parse files → build registries → resolve calls → emit graph batches.
 * Ported from agent's SymbolAttacher.attach() two-phase pattern.
 *
 * Architecture: streaming per-file pipeline where each file flows through
 * extract → register → summarize → emit in a single pass, so nodes with
 * summaries appear incrementally in the UI.
 */

import type { Parser, Node as SyntaxNode } from 'web-tree-sitter';
import {
  EXTENSION_LANGUAGE_MAP,
  PARSEABLE_LANGUAGES,
} from '../loader/constants';
import { extractPython } from './extractors/python';
import { extractTypeScript } from './extractors/typescript';
import { extractGo } from './extractors/go';
import { extractGeneric } from './extractors/generic';
import { analyzeImports } from './importAnalyzer';
import {
  isManifestFile,
  parseManifest,
  packageId,
  packageSourceUrl,
} from './manifestParser';
import {
  resolveCalls,
  resolvedCallsToRelationships,
  type CallInfo,
  type Registries,
  type SymbolNode,
} from './callResolver';
import type { NodeKind, SymbolMetadata } from '../enricher/summarizer/types';
import type { SummarizationStrategy } from '../enricher/summarizer/strategy';
import type {
  CodeSymbol,
  EnrichItem,
  ExtractionResult,
  GraphBatch,
  GraphNode,
  GraphRelationship,
  RepoFile,
  RepoTree,
} from '../types';

export interface PipelineCallbacks {
  onProgress: (
    phase: string,
    message: string,
    current: number,
    total: number,
    fileName?: string,
  ) => void;
  onBatch: (batch: GraphBatch) => void;
  onStageComplete: (phase: string, message: string) => void;
}

/** Map from language name (e.g. "python", "tsx") to a configured Parser instance. */
export type ParserMap = Map<string, Parser>;

/** Symbol info collected during processSymbol for inline summarization. */
interface SymbolInfo {
  nodeId: string;
  startLine: number;
  endLine: number;
  kind: NodeKind;
  name: string;
  signature?: string;
  childNames?: string[];
  receiverType?: string;
  docs?: string;
}

/** Run the full indexing pipeline on a repo tree. */
export async function runPipeline(
  repo: RepoTree,
  parsers: ParserMap,
  callbacks: PipelineCallbacks,
  strategy: SummarizationStrategy,
): Promise<{
  filesProcessed: number;
  nodesCreated: number;
  relationshipsCreated: number;
  errors: string[];
  enrichItems: EnrichItem[];
}> {
  const repoId = `${repo.owner}/${repo.repo}`;
  const errors: string[] = [];
  let totalNodes = 0;
  let totalRels = 0;

  // --- Source link helpers ---
  // Build a browsable URL for a file path (+ optional line range) on the provider.
  const repoUrl = repo.url;
  const branch = repo.ref;
  const provider = repo.provider;

  function buildSourceUri(
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): string | undefined {
    if (!repoUrl) return undefined;
    let blobBase: string;
    if (provider === 'gitlab') {
      blobBase = `${repoUrl}/-/blob/${branch}/${filePath}`;
    } else {
      // GitHub / default
      blobBase = `${repoUrl}/blob/${branch}/${filePath}`;
    }
    if (startLine != null && endLine != null) {
      return `${blobBase}#L${startLine}-L${endLine}`;
    }
    if (startLine != null) {
      return `${blobBase}#L${startLine}`;
    }
    return blobBase;
  }

  /** Common source-tracking properties added to File/Directory/Class/Function nodes. */
  function sourceProps(
    filePath: string,
    startLine?: number,
    endLine?: number,
  ): Record<string, unknown> {
    const props: Record<string, unknown> = { branch };
    if (provider) props.source_name = provider;
    const uri = buildSourceUri(filePath, startLine, endLine);
    if (uri) props.source_uri = uri;
    return props;
  }

  // Create the repo node (template summary — no ML needed)
  const repoNode: GraphNode = {
    id: repoId,
    type: 'Repository',
    name: repo.repo,
    properties: {
      url: repo.url ?? `https://github.com/${repoId}`,
      ref: repo.ref,
      owner: repo.owner,
      summary: `Source code repository for ${repo.repo}, maintained by ${repo.owner}`,
    },
  };

  // Build directory structure and file nodes
  const dirNodes = new Map<string, GraphNode>();
  const fileNodes: GraphNode[] = [];
  const structureRels: GraphRelationship[] = [];

  // Filter to parseable files
  const parseableFiles: RepoFile[] = [];

  for (const file of repo.files) {
    const ext = getExtension(file.path);
    const language = EXTENSION_LANGUAGE_MAP[ext];

    // Create file node
    const fileId = `${repoId}/${file.path}`;
    const fileName = file.path.split('/').pop()!;
    const fileNode: GraphNode = {
      id: fileId,
      type: 'File',
      name: fileName,
      properties: {
        path: file.path,
        extension: ext,
        language: language ?? undefined,
        ...sourceProps(file.path),
      },
    };
    fileNodes.push(fileNode);

    // Create directory nodes and relationships
    const dirPath = parentDir(file.path);
    ensureDirectoryChain(repoId, dirPath, dirNodes, structureRels, (dp) =>
      sourceProps(dp),
    );

    // Link file to parent dir (or repo): File DEFINED_IN Directory
    const parentId = dirPath ? `${repoId}/${dirPath}` : repoId;
    structureRels.push({
      id: `${fileId}->DEFINED_IN->${parentId}`,
      type: 'DEFINED_IN',
      source_id: fileId,
      target_id: parentId,
    });

    if (language && PARSEABLE_LANGUAGES.has(language)) {
      parseableFiles.push(file);
    }
  }

  // Emit structure batch (repo + dirs + files)
  const structureBatch: GraphBatch = {
    nodes: [repoNode, ...Array.from(dirNodes.values()), ...fileNodes],
    relationships: structureRels,
  };
  callbacks.onBatch(structureBatch);
  totalNodes += structureBatch.nodes.length;
  totalRels += structureBatch.relationships.length;

  // --- Manifest parsing: create Package nodes + depends_on relationships ---
  const packageNodes = new Map<string, GraphNode>();
  const emittedPackageIds = new Set<string>();
  const dependencyRels: GraphRelationship[] = [];
  const externalImportRels: GraphRelationship[] = [];
  let goModulePath: string | undefined;

  for (const file of repo.files) {
    if (!isManifestFile(file.path)) continue;

    const manifestResult = parseManifest(file.path, file.content);
    errors.push(...manifestResult.errors);

    // Extract Go module path for import resolution
    if (file.path.endsWith('go.mod') || file.path.includes('/go.mod')) {
      const moduleMatch = file.content.match(/^module\s+(\S+)/m);
      if (moduleMatch) goModulePath = moduleMatch[1];
    }

    for (const dep of manifestResult.dependencies) {
      const pkgId = packageId(dep.registry, dep.name);
      if (!packageNodes.has(pkgId)) {
        const pkgUrl = packageSourceUrl(dep.registry, dep.name);
        packageNodes.set(pkgId, {
          id: pkgId,
          type: 'Package',
          name: dep.name,
          properties: {
            version: dep.version,
            registry: dep.registry,
            source: dep.source,
            dependency_type: dep.dependencyType,
            ...(pkgUrl
              ? { source_uri: pkgUrl, source_name: dep.registry }
              : {}),
          },
        });
      }
      dependencyRels.push({
        id: `${repoId}/${dep.source}->DEPENDS_ON->${pkgId}`,
        type: 'DEPENDS_ON',
        source_id: repoId,
        target_id: pkgId,
        properties: {
          source: dep.source,
          dependency_type: dep.dependencyType,
          version: dep.version,
        },
      });
    }
  }

  // Emit manifest batch
  if (packageNodes.size > 0 || dependencyRels.length > 0) {
    callbacks.onBatch({
      nodes: Array.from(packageNodes.values()),
      relationships: dependencyRels,
    });
    for (const id of packageNodes.keys()) emittedPackageIds.add(id);
    totalNodes += packageNodes.size;
    totalRels += dependencyRels.length;
  }

  // --- Streaming per-file loop: extract → register → summarize → emit ---
  callbacks.onProgress(
    'parsing',
    'Extracting symbols...',
    0,
    parseableFiles.length,
  );

  const registries: Registries = {
    nameRegistry: new Map(),
    fileRegistry: new Map(),
    classRegistry: new Map(),
    importRegistry: new Map(),
  };
  const allCallInfo: CallInfo[] = [];
  const enrichItems: EnrichItem[] = [];
  const dirChildNames = new Map<string, string[]>();

  // Aggregate counts for stage-complete messages
  let totalClasses = 0;
  let totalFunctions = 0;
  let totalFileSummaries = 0;

  // Pre-compute known paths for import resolution
  const knownPaths = new Set(repo.files.map((f) => f.path));
  const pathToFileId = new Map<string, string>();
  for (const file of repo.files) {
    pathToFileId.set(file.path, `${repoId}/${file.path}`);
  }

  for (let i = 0; i < parseableFiles.length; i++) {
    const file = parseableFiles[i];
    const shortName = file.path.split('/').pop()!;
    callbacks.onProgress(
      'parsing',
      `Extracting symbols from ${shortName}`,
      i,
      parseableFiles.length,
      file.path,
    );

    try {
      const result = extractFile(file, repoId, parsers);
      if (!result) continue;

      const { extraction, fileId } = result;
      const filePath = file.path;
      const fileName = file.path.split('/').pop()!;
      const ext = getExtension(file.path);
      const language = EXTENSION_LANGUAGE_MAP[ext];

      // Per-file batch: symbol nodes + DEFINED_IN rels + summary update nodes
      const fileBatch: GraphBatch = { nodes: [], relationships: [] };

      // Local array replaces the old symbolLineInfo map
      const symbolInfoOut: SymbolInfo[] = [];

      registries.fileRegistry.set(fileId, new Map());

      // (a) Analyze imports
      if (extraction.rootNode) {
        const importResult = analyzeImports(
          extraction.rootNode,
          extraction.language,
          filePath,
          knownPaths,
          goModulePath,
        );

        // Internal imports
        if (Object.keys(importResult.internal).length > 0) {
          const idImports: Record<string, string> = {};
          for (const [alias, targetPath] of Object.entries(
            importResult.internal,
          )) {
            const targetId = pathToFileId.get(targetPath);
            if (targetId) idImports[alias] = targetId;
          }
          if (Object.keys(idImports).length > 0) {
            registries.importRegistry.set(fileId, idImports);
          }
        }

        // External imports — collect File→Package relationships
        for (const [pkgName, pkgId] of Object.entries(importResult.external)) {
          if (!packageNodes.has(pkgId)) {
            const reg = pkgId.split(':')[1];
            const pkgUrl = packageSourceUrl(reg, pkgName);
            packageNodes.set(pkgId, {
              id: pkgId,
              type: 'Package',
              name: pkgName,
              properties: {
                registry: reg,
                ...(pkgUrl ? { source_uri: pkgUrl, source_name: reg } : {}),
              },
            });
          }
          externalImportRels.push({
            id: `${fileId}->IMPORTS->${pkgId}`,
            type: 'IMPORTS',
            source_id: fileId,
            target_id: pkgId,
          });
        }
      }

      // (b) Convert symbols to graph nodes, collect into symbolInfoOut
      const fileSourceProps = (startLine: number, endLine: number) =>
        sourceProps(filePath, startLine, endLine);
      for (const symbol of extraction.symbols) {
        processSymbol(
          symbol,
          fileId,
          extraction.language,
          registries,
          allCallInfo,
          fileBatch,
          symbolInfoOut,
          fileSourceProps,
        );
      }

      // Count symbols for this file
      const fileClasses = symbolInfoOut.filter(
        (s) => s.kind === 'class',
      ).length;
      const fileFunctions = symbolInfoOut.filter(
        (s) => s.kind === 'function',
      ).length;
      totalClasses += fileClasses;
      totalFunctions += fileFunctions;

      // Update progress with extraction results
      if (symbolInfoOut.length > 0) {
        const parts: string[] = [];
        if (fileClasses > 0)
          parts.push(`${fileClasses} class${fileClasses > 1 ? 'es' : ''}`);
        if (fileFunctions > 0)
          parts.push(
            `${fileFunctions} function${fileFunctions > 1 ? 's' : ''}`,
          );
        callbacks.onProgress(
          'parsing',
          `${fileName}: ${parts.join(', ')}`,
          i,
          parseableFiles.length,
          file.path,
        );
      }

      // (c) Summarize each symbol inline (using symbolInfoOut + file content lines)
      const lines = file.content.split('\n');
      const symbolNames: string[] = [];
      for (const info of symbolInfoOut) {
        symbolNames.push(info.name);
        const snippet = lines
          .slice(info.startLine - 1, info.endLine)
          .join('\n');
        if (!snippet.trim()) continue;

        const meta: SymbolMetadata = {
          name: info.name,
          kind: info.kind,
          signature: info.signature,
          language: language ?? undefined,
          lineCount: info.endLine - info.startLine + 1,
          childNames: info.childNames,
          receiverType: info.receiverType,
          source: snippet,
          docs: info.docs,
        };
        let summary = '';
        try {
          summary = await strategy.summarize(meta);
        } catch {
          errors.push(`Failed to summarize ${info.kind} ${info.name}`);
        }
        const nodeType = info.kind === 'class' ? 'Class' : 'Function';
        enrichItems.push({
          source: snippet,
          kind: info.kind,
          nodeId: info.nodeId,
          nodeType,
          nodeName: info.name,
          summary,
        });
        if (summary) {
          fileBatch.nodes.push({
            id: info.nodeId,
            type: nodeType,
            name: info.name,
            properties: { summary },
          });
        }
      }

      // (d) Summarize the file itself (first 200 lines + symbol names)
      const fileSource = lines.slice(0, 200).join('\n');
      if (fileSource.trim()) {
        const fileMeta: SymbolMetadata = {
          name: fileName,
          kind: 'file',
          fileName: filePath,
          language: language ?? undefined,
          childNames: symbolNames.length > 0 ? symbolNames : undefined,
          source: fileSource,
        };
        let fileSummary = '';
        try {
          fileSummary = await strategy.summarize(fileMeta);
        } catch {
          errors.push(`Failed to summarize file ${filePath}`);
        }
        enrichItems.push({
          source: fileSource,
          kind: 'file',
          nodeId: fileId,
          nodeType: 'File',
          nodeName: fileName,
          path: filePath,
          summary: fileSummary,
        });
        if (fileSummary) {
          totalFileSummaries++;
          fileBatch.nodes.push({
            id: fileId,
            type: 'File',
            name: fileName,
            properties: { summary: fileSummary },
          });
        }
      }

      // (e) Emit per-file batch
      if (fileBatch.nodes.length > 0 || fileBatch.relationships.length > 0) {
        callbacks.onBatch(fileBatch);
        totalNodes += fileBatch.nodes.length;
        totalRels += fileBatch.relationships.length;
      }

      // (f) Track directory child names for directory summaries later
      const dirPath = filePath.includes('/')
        ? filePath.slice(0, filePath.lastIndexOf('/'))
        : '';
      const parentDirId = dirPath ? `${repoId}/${dirPath}` : repoId;
      const names = dirChildNames.get(parentDirId) ?? [];
      names.push(fileName);
      dirChildNames.set(parentDirId, names);
    } catch (err) {
      errors.push(`Failed to parse ${file.path}: ${err}`);
    }
  }

  // --- Post-loop: external imports, call resolution, directory summaries ---

  // Emit external import Package nodes + File→Package relationships
  const newPackageNodes = Array.from(packageNodes.values()).filter(
    (n) => !emittedPackageIds.has(n.id),
  );
  if (externalImportRels.length > 0 || newPackageNodes.length > 0) {
    callbacks.onBatch({
      nodes: newPackageNodes,
      relationships: externalImportRels,
    });
    totalNodes += newPackageNodes.length;
    totalRels += externalImportRels.length;
  }

  const parseParts = [`${parseableFiles.length} files`];
  if (totalClasses > 0) parseParts.push(`${totalClasses} classes`);
  if (totalFunctions > 0) parseParts.push(`${totalFunctions} functions`);
  callbacks.onStageComplete('parsing', `Parsed ${parseParts.join(', ')}`);

  // Phase 2: Resolve calls
  callbacks.onProgress('resolving', 'Resolving call relationships...', 0, 1);

  const resolvedCalls = resolveCalls(allCallInfo, registries);
  const callRels = resolvedCallsToRelationships(resolvedCalls);

  if (callRels.length > 0) {
    callbacks.onBatch({ nodes: [], relationships: callRels });
    totalRels += callRels.length;
  }

  callbacks.onProgress(
    'resolving',
    `Resolved ${callRels.length} call relationships`,
    1,
    1,
  );
  callbacks.onStageComplete(
    'resolving',
    `Resolved ${callRels.length} call relationships`,
  );

  // Phase 3: Directory summaries (needs all children known)
  const dirSummaryNodes: GraphNode[] = [];
  const dirEntries = Array.from(dirNodes.entries());

  if (dirEntries.length > 0) {
    callbacks.onProgress(
      'summarizing',
      'Summarizing directories...',
      0,
      dirEntries.length,
    );
  }

  for (let di = 0; di < dirEntries.length; di++) {
    const [dirId, dirNode] = dirEntries[di];
    const dirPath = (dirNode.properties?.path as string) || dirNode.name;
    const childNames = [...(dirChildNames.get(dirId) ?? [])];
    for (const [otherId, otherNode] of dirNodes) {
      const otherPath = (otherNode.properties?.path as string) || '';
      const otherParent = otherPath.includes('/')
        ? otherPath.slice(0, otherPath.lastIndexOf('/'))
        : '';
      if (otherParent === dirPath && otherId !== dirId) {
        childNames.push(otherNode.name + '/');
      }
    }
    if (childNames.length > 0) {
      callbacks.onProgress(
        'summarizing',
        `Summarizing ${dirNode.name}/ (${childNames.length} items)`,
        di,
        dirEntries.length,
      );
      const dirMeta: SymbolMetadata = {
        name: dirNode.name,
        kind: 'directory',
        childNames,
      };
      let summary = '';
      try {
        summary = await strategy.summarize(dirMeta);
      } catch {
        errors.push(`Failed to summarize directory ${dirNode.name}`);
      }
      const listing = `${dirPath}/ contains: ${childNames.join(', ')}`;
      enrichItems.push({
        source: listing,
        kind: 'directory',
        nodeId: dirId,
        nodeType: 'Directory',
        nodeName: dirNode.name,
        path: dirPath,
        summary,
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

  if (dirSummaryNodes.length > 0) {
    callbacks.onBatch({ nodes: dirSummaryNodes, relationships: [] });
  }

  const summaryParts: string[] = [];
  if (totalFileSummaries > 0) summaryParts.push(`${totalFileSummaries} files`);
  if (totalClasses > 0) summaryParts.push(`${totalClasses} classes`);
  if (totalFunctions > 0) summaryParts.push(`${totalFunctions} functions`);
  if (dirSummaryNodes.length > 0)
    summaryParts.push(`${dirSummaryNodes.length} directories`);
  callbacks.onStageComplete(
    'summarizing',
    `Summarized ${summaryParts.join(', ')}`,
  );

  return {
    filesProcessed: parseableFiles.length,
    nodesCreated: totalNodes,
    relationshipsCreated: totalRels,
    errors,
    enrichItems,
  };
}

function extractFile(
  file: RepoFile,
  repoId: string,
  parsers: ParserMap,
): { extraction: ExtractionResult; fileId: string } | null {
  const ext = getExtension(file.path);
  const language = EXTENSION_LANGUAGE_MAP[ext];
  const fileId = `${repoId}/${file.path}`;

  if (!language || !PARSEABLE_LANGUAGES.has(language)) return null;

  let parser: Parser | undefined;
  let extractFn: ((rootNode: SyntaxNode) => ExtractionResult) | null = null;

  switch (language) {
    case 'python':
      parser = parsers.get('python');
      extractFn = extractPython;
      break;
    case 'typescript':
      parser = ext === '.tsx' ? parsers.get('tsx') : parsers.get('typescript');
      extractFn = extractTypeScript;
      break;
    case 'javascript':
      parser = parsers.get('tsx'); // TSX parser handles JS/JSX as a superset
      extractFn = (rootNode) => extractTypeScript(rootNode, 'javascript');
      break;
    case 'go':
      parser = parsers.get('go');
      extractFn = extractGo;
      break;
    default:
      // All other parseable languages use the generic extractor
      parser = parsers.get(language);
      extractFn = (rootNode) => extractGeneric(rootNode, language);
      break;
  }

  if (!parser || !extractFn) return null;

  const tree = parser.parse(file.content);
  if (!tree) return null;
  const extraction = extractFn(tree.rootNode);
  return { extraction, fileId };
}

function processSymbol(
  symbol: CodeSymbol,
  parentId: string,
  language: string,
  registries: Registries,
  callInfos: CallInfo[],
  batch: GraphBatch,
  symbolInfoOut: SymbolInfo[],
  extraProps?: (startLine: number, endLine: number) => Record<string, unknown>,
): SymbolNode {
  const fileId = parentId.split('::')[0];
  const namePart = symbol.receiverType
    ? `${symbol.receiverType}.${symbol.name}`
    : symbol.name;
  const nodeId = `${parentId}::${namePart}`;

  if (symbol.kind === 'class') {
    const graphNode: GraphNode = {
      id: nodeId,
      type: 'Class',
      name: symbol.name,
      properties: {
        language,
        start_line: symbol.startLine,
        end_line: symbol.endLine,
        signature: symbol.signature ?? undefined,
        superclasses: symbol.superclasses ?? undefined,
        interfaces: symbol.interfaces ?? undefined,
        subtype: symbol.subtype ?? undefined,
        docs: symbol.docs ?? undefined,
        ...extraProps?.(symbol.startLine, symbol.endLine),
      },
    };
    batch.nodes.push(graphNode);
    batch.relationships.push({
      id: `${nodeId}->DEFINED_IN->${parentId}`,
      type: 'DEFINED_IN',
      source_id: nodeId,
      target_id: parentId,
    });

    // Collect symbol info for inline summarization
    symbolInfoOut.push({
      nodeId,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      kind: 'class',
      name: symbol.name,
      childNames: symbol.children.map((c) => c.name),
      docs: symbol.docs,
    });

    // Register in registries
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

    // Process child methods
    for (const child of symbol.children) {
      const childSymbolNode = processSymbol(
        child,
        nodeId,
        language,
        registries,
        callInfos,
        batch,
        symbolInfoOut,
        extraProps,
      );
      symbolNode.children.push(childSymbolNode);
    }

    return symbolNode;
  } else {
    const graphNode: GraphNode = {
      id: nodeId,
      type: 'Function',
      name: symbol.name,
      properties: {
        language,
        start_line: symbol.startLine,
        end_line: symbol.endLine,
        signature: symbol.signature ?? undefined,
        docs: symbol.docs ?? undefined,
        ...extraProps?.(symbol.startLine, symbol.endLine),
      },
    };
    batch.nodes.push(graphNode);
    batch.relationships.push({
      id: `${nodeId}->DEFINED_IN->${parentId}`,
      type: 'DEFINED_IN',
      source_id: nodeId,
      target_id: parentId,
    });

    // Collect symbol info for inline summarization
    symbolInfoOut.push({
      nodeId,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      kind: 'function',
      name: symbol.name,
      signature: symbol.signature ?? undefined,
      receiverType: symbol.receiverType ?? undefined,
      docs: symbol.docs,
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

function addToRegistry(
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

function ensureDirectoryChain(
  repoId: string,
  dirPath: string,
  dirNodes: Map<string, GraphNode>,
  rels: GraphRelationship[],
  extraProps?: (dirPath: string) => Record<string, unknown>,
): void {
  if (!dirPath) return;

  const dirId = `${repoId}/${dirPath}`;
  if (dirNodes.has(dirId)) return;

  const dirName = dirPath.split('/').pop()!;
  dirNodes.set(dirId, {
    id: dirId,
    type: 'Directory',
    name: dirName,
    properties: { path: dirPath, ...extraProps?.(dirPath) },
  });

  const parentPath = parentDir(dirPath);
  if (parentPath) {
    ensureDirectoryChain(repoId, parentPath, dirNodes, rels, extraProps);
    const parentDirId = `${repoId}/${parentPath}`;
    rels.push({
      id: `${dirId}->DEFINED_IN->${parentDirId}`,
      type: 'DEFINED_IN',
      source_id: dirId,
      target_id: parentDirId,
    });
  } else {
    rels.push({
      id: `${dirId}->DEFINED_IN->${repoId}`,
      type: 'DEFINED_IN',
      source_id: dirId,
      target_id: repoId,
    });
  }
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

function getExtension(fileName: string): string {
  const name = fileName.split('/').pop()!.toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile.'))
    return '.dockerfile';
  const dotIdx = name.lastIndexOf('.');
  return dotIdx >= 0 ? name.slice(dotIdx) : '';
}
