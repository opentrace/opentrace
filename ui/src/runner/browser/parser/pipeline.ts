/**
 * Full indexing pipeline: parse files → build registries → resolve calls → emit graph batches.
 * Ported from agent's SymbolAttacher.attach() two-phase pattern.
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

    // Link file to parent dir (or repo): File defined_in Directory
    const parentId = dirPath ? `${repoId}/${dirPath}` : repoId;
    structureRels.push({
      id: `${fileId}->defined_in->${parentId}`,
      type: 'defined_in',
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
        id: `${repoId}/${dep.source}->depends_on->${pkgId}`,
        type: 'depends_on',
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

  // Phase 1: Extract symbols and build registries
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

  // Track line info for summarization, indexed by fileId for O(1) per-file lookup
  const symbolLineInfo = new Map<
    string,
    Array<{
      nodeId: string;
      startLine: number;
      endLine: number;
      kind: NodeKind;
      name: string;
      signature?: string;
      childNames?: string[];
      receiverType?: string;
    }>
  >();

  // Pre-compute known paths for import resolution
  const knownPaths = new Set(repo.files.map((f) => f.path));
  const pathToFileId = new Map<string, string>();
  for (const file of repo.files) {
    pathToFileId.set(file.path, `${repoId}/${file.path}`);
  }

  for (let i = 0; i < parseableFiles.length; i++) {
    const file = parseableFiles[i];
    callbacks.onProgress(
      'parsing',
      `Parsing ${file.path}`,
      i,
      parseableFiles.length,
      file.path,
    );

    try {
      const result = extractFile(file, repoId, parsers);
      if (!result) continue;

      const { extraction, fileId } = result;
      const filePath = file.path;

      // Build symbol nodes and graph nodes for this file
      const symbolBatch: GraphBatch = { nodes: [], relationships: [] };

      registries.fileRegistry.set(fileId, new Map());

      // Analyze imports
      if (extraction.rootNode) {
        const importResult = analyzeImports(
          extraction.rootNode,
          extraction.language,
          filePath,
          knownPaths,
          goModulePath,
        );

        // Internal imports (existing logic)
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
            id: `${fileId}->imports->${pkgId}`,
            type: 'imports',
            source_id: fileId,
            target_id: pkgId,
          });
        }
      }

      // Convert symbols to graph nodes
      const fileSourceProps = (startLine: number, endLine: number) =>
        sourceProps(filePath, startLine, endLine);
      for (const symbol of extraction.symbols) {
        processSymbol(
          symbol,
          fileId,
          extraction.language,
          registries,
          allCallInfo,
          symbolBatch,
          symbolLineInfo,
          fileSourceProps,
        );
      }

      if (
        symbolBatch.nodes.length > 0 ||
        symbolBatch.relationships.length > 0
      ) {
        callbacks.onBatch(symbolBatch);
        totalNodes += symbolBatch.nodes.length;
        totalRels += symbolBatch.relationships.length;
      }
    } catch (err) {
      errors.push(`Failed to parse ${file.path}: ${err}`);
    }
  }

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

  callbacks.onStageComplete('parsing', `Parsed ${parseableFiles.length} files`);

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

  // Collect enrichment items and generate summaries
  const enrichItems: EnrichItem[] = [];
  const summaryUpdateNodes: GraphNode[] = [];

  // Track file names and symbol names per directory/file for composing summaries
  const dirChildNames = new Map<string, string[]>();
  const fileTopSymbols = new Map<string, string[]>();

  // First pass: collect file-level symbol names and count total summarizable items
  let totalSummarizeItems = dirNodes.size; // directories
  for (const file of parseableFiles) {
    const fileId = `${repoId}/${file.path}`;
    const fileSymbols = symbolLineInfo.get(fileId);
    if (fileSymbols) {
      fileTopSymbols.set(
        fileId,
        fileSymbols.map((s) => s.name),
      );
      totalSummarizeItems += fileSymbols.length;
    }
    // Count the file itself if it has content
    const fileSource = file.content.split('\n').slice(0, 200).join('\n');
    if (fileSource.trim()) totalSummarizeItems++;
  }

  let summarizedCount = 0;
  callbacks.onProgress(
    'summarizing',
    'Generating summaries...',
    0,
    totalSummarizeItems,
  );

  for (const file of parseableFiles) {
    const fileId = `${repoId}/${file.path}`;
    const fileName = file.path.split('/').pop()!;
    const ext = getExtension(file.path);
    const language = EXTENSION_LANGUAGE_MAP[ext];
    const dirPath = file.path.includes('/')
      ? file.path.slice(0, file.path.lastIndexOf('/'))
      : '';
    const parentDirId = dirPath ? `${repoId}/${dirPath}` : repoId;

    // Track file names per directory
    const names = dirChildNames.get(parentDirId) ?? [];
    names.push(fileName);
    dirChildNames.set(parentDirId, names);

    // File item (first ~200 lines for keyword extraction)
    const fileSource = file.content.split('\n').slice(0, 200).join('\n');
    if (fileSource.trim()) {
      const fileMeta: SymbolMetadata = {
        name: fileName,
        kind: 'file',
        fileName: file.path,
        language: language ?? undefined,
        childNames: fileTopSymbols.get(fileId),
        source: fileSource,
      };
      let fileSummary = '';
      try {
        fileSummary = await strategy.summarize(fileMeta);
      } catch {
        errors.push(`Failed to summarize file ${file.path}`);
      }
      summarizedCount++;
      callbacks.onProgress(
        'summarizing',
        `Summarizing ${fileName}`,
        summarizedCount,
        totalSummarizeItems,
        file.path,
      );
      enrichItems.push({
        source: fileSource,
        kind: 'file',
        nodeId: fileId,
        nodeType: 'File',
        nodeName: fileName,
        path: file.path,
        summary: fileSummary,
      });
      if (fileSummary) {
        summaryUpdateNodes.push({
          id: fileId,
          type: 'File',
          name: fileName,
          properties: { summary: fileSummary },
        });
      }
    }

    // Symbol items
    const fileSymbols = symbolLineInfo.get(fileId);
    if (!fileSymbols) continue;

    const lines = file.content.split('\n');
    for (const info of fileSymbols) {
      const snippet = lines.slice(info.startLine - 1, info.endLine).join('\n');
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
      };
      let summary = '';
      try {
        summary = await strategy.summarize(meta);
      } catch {
        errors.push(`Failed to summarize ${info.kind} ${info.name}`);
      }
      summarizedCount++;
      callbacks.onProgress(
        'summarizing',
        `Summarizing ${info.name}`,
        summarizedCount,
        totalSummarizeItems,
        file.path,
      );
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
        summaryUpdateNodes.push({
          id: info.nodeId,
          type: nodeType,
          name: info.name,
          properties: { summary },
        });
      }
    }
  }

  // Directory items
  for (const [dirId, dirNode] of dirNodes) {
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
      summarizedCount++;
      callbacks.onProgress(
        'summarizing',
        `Summarizing ${dirNode.name}/`,
        summarizedCount,
        totalSummarizeItems,
      );
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
        summaryUpdateNodes.push({
          id: dirId,
          type: 'Directory',
          name: dirNode.name,
          properties: { summary },
        });
      }
    }
  }

  // Emit all template summaries as a graph update batch (summaries appear immediately)
  if (summaryUpdateNodes.length > 0) {
    callbacks.onBatch({ nodes: summaryUpdateNodes, relationships: [] });
  }

  callbacks.onProgress(
    'summarizing',
    `Generated ${summaryUpdateNodes.length} summaries`,
    summarizedCount,
    totalSummarizeItems,
  );
  callbacks.onStageComplete(
    'summarizing',
    `Generated ${summaryUpdateNodes.length} summaries`,
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
  symbolLineInfo?: Map<
    string,
    Array<{
      nodeId: string;
      startLine: number;
      endLine: number;
      kind: NodeKind;
      name: string;
      signature?: string;
      childNames?: string[];
      receiverType?: string;
    }>
  >,
  extraProps?: (startLine: number, endLine: number) => Record<string, unknown>,
): SymbolNode {
  const fileId = parentId.split('::')[0];
  const nodeId = `${parentId}::${symbol.name}`;

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
        ...extraProps?.(symbol.startLine, symbol.endLine),
      },
    };
    batch.nodes.push(graphNode);
    batch.relationships.push({
      id: `${nodeId}->defined_in->${parentId}`,
      type: 'defined_in',
      source_id: nodeId,
      target_id: parentId,
    });

    // Track line info for summarization (indexed by fileId)
    if (symbolLineInfo) {
      const arr = symbolLineInfo.get(fileId) ?? [];
      arr.push({
        nodeId,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        kind: 'class',
        name: symbol.name,
        childNames: symbol.children.map((c) => c.name),
      });
      symbolLineInfo.set(fileId, arr);
    }

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
        symbolLineInfo,
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
        ...extraProps?.(symbol.startLine, symbol.endLine),
      },
    };
    batch.nodes.push(graphNode);
    batch.relationships.push({
      id: `${nodeId}->defined_in->${parentId}`,
      type: 'defined_in',
      source_id: nodeId,
      target_id: parentId,
    });

    // Track line info for summarization (indexed by fileId)
    if (symbolLineInfo) {
      const arr = symbolLineInfo.get(fileId) ?? [];
      arr.push({
        nodeId,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        kind: 'function',
        name: symbol.name,
        signature: symbol.signature ?? undefined,
        receiverType: symbol.receiverType ?? undefined,
      });
      symbolLineInfo.set(fileId, arr);
    }

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
      id: `${dirId}->defined_in->${parentDirId}`,
      type: 'defined_in',
      source_id: dirId,
      target_id: parentDirId,
    });
  } else {
    rels.push({
      id: `${dirId}->defined_in->${repoId}`,
      type: 'defined_in',
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
