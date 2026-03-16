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
 * Scanning stage: builds the structural graph (Repo, Dir, File, Package nodes)
 * and pre-computes lookup maps for downstream stages.
 */

import type {
  GraphNode,
  GraphRelationship,
  LoadingInput,
  ScanResult,
  PipelineContext,
  PipelineEvent,
  RepoFile,
} from '../types';
import {
  getExtension,
  detectLanguage,
  parentDir,
  ensureDirChain,
} from './loading';
import {
  isManifestFile,
  parseManifest,
  packageId,
  packageSourceUrl,
} from '../../runner/browser/parser/manifestParser';

const PARSEABLE_LANGUAGES = new Set([
  'python',
  'typescript',
  'javascript',
  'go',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'c',
  'cpp',
  'ruby',
  'swift',
]);

export function* execute(
  input: LoadingInput,
  ctx: PipelineContext,
): Generator<PipelineEvent, ScanResult> {
  const { repo } = input;
  const repoId = `${repo.owner}/${repo.repo}`;

  yield {
    kind: 'stage_start',
    phase: 'scanning',
    message: `Scanning ${repo.files.length} files`,
  };

  const repoProps: Record<string, unknown> = { ref: repo.ref };
  if (repo.url) repoProps.source_uri = repo.url;
  if (repo.provider) repoProps.provider = repo.provider;

  const repoNode: GraphNode = {
    id: repoId,
    type: 'Repository',
    name: repoId,
    properties: repoProps,
  };

  const dirNodes = new Map<string, GraphNode>();
  const fileNodes: GraphNode[] = [];
  const structureRels: GraphRelationship[] = [];
  const parseableFiles: RepoFile[] = [];
  const packageNodes = new Map<string, GraphNode>();
  const dependencyRels: GraphRelationship[] = [];
  let goModulePath: string | undefined;

  // Pre-compute lookup maps for downstream stages
  const knownPaths = new Set<string>();
  const pathToFileId = new Map<string, string>();

  const total = repo.files.length;

  for (let i = 0; i < repo.files.length; i++) {
    if (ctx.cancelled) break;

    const file = repo.files[i];
    const ext = getExtension(file.path);
    const language = detectLanguage(ext);

    const fileId = `${repoId}/${file.path}`;
    const fileName = file.path.includes('/')
      ? file.path.slice(file.path.lastIndexOf('/') + 1)
      : file.path;

    const fileProps: Record<string, unknown> = {
      path: file.path,
      extension: ext,
    };
    if (language) fileProps.language = language;
    if (repo.url) {
      fileProps.source_uri = `${repo.url}/blob/${repo.ref}/${file.path}`;
    }

    fileNodes.push({
      id: fileId,
      type: 'File',
      name: fileName,
      properties: fileProps,
    });

    const dir = parentDir(file.path);
    ensureDirChain(repoId, dir, dirNodes, structureRels);

    const parentId = dir ? `${repoId}/${dir}` : repoId;
    structureRels.push({
      id: `${fileId}->DEFINED_IN->${parentId}`,
      type: 'DEFINED_IN',
      source_id: fileId,
      target_id: parentId,
    });

    if (language && PARSEABLE_LANGUAGES.has(language)) {
      parseableFiles.push(file);
    }

    // Populate lookup maps
    knownPaths.add(file.path);
    pathToFileId.set(file.path, fileId);

    // Manifest parsing: extract Package nodes + DEPENDS_ON rels
    if (isManifestFile(file.path)) {
      const manifestResult = parseManifest(file.path, file.content);

      if (file.path.endsWith('go.mod') || file.path.includes('/go.mod')) {
        const moduleMatch = file.content.match(/^module\s+(\S+)/m);
        if (moduleMatch) goModulePath = moduleMatch[1];
      }

      for (const dep of manifestResult.dependencies) {
        const pkgId = packageId(dep.registry, dep.name);
        if (!packageNodes.has(pkgId)) {
          const props: Record<string, unknown> = {
            registry: dep.registry,
            version: dep.version,
          };
          const sourceUrl = packageSourceUrl(dep.registry, dep.name);
          if (sourceUrl) props.source_uri = sourceUrl;

          packageNodes.set(pkgId, {
            id: pkgId,
            type: 'Package',
            name: dep.name,
            properties: props,
          });
        }

        dependencyRels.push({
          id: `${repoId}->DEPENDS_ON->${pkgId}`,
          type: 'DEPENDS_ON',
          source_id: repoId,
          target_id: pkgId,
          properties: {
            version: dep.version,
            dependency_type: dep.dependencyType,
            source: dep.source,
          },
        });
      }
    }

    yield {
      kind: 'stage_progress',
      phase: 'scanning',
      message: `Scanning ${file.path}`,
      detail: { current: i + 1, total, fileName: file.path },
    };
  }

  const structureNodes: GraphNode[] = [
    repoNode,
    ...dirNodes.values(),
    ...fileNodes,
    ...packageNodes.values(),
  ];

  yield {
    kind: 'stage_stop',
    phase: 'scanning',
    message: `Scanned ${fileNodes.length} files, ${dirNodes.size} directories, ${packageNodes.size} packages`,
    nodes: structureNodes,
    relationships: [...structureRels, ...dependencyRels],
  };

  return {
    repo,
    repoId,
    repoNode,
    dirNodes,
    fileNodes,
    structureRels,
    parseableFiles,
    packageNodes,
    dependencyRels,
    goModulePath,
    knownPaths,
    pathToFileId,
  };
}
