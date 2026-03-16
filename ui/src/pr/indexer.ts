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
 * Indexes PR data into the OpenTrace knowledge graph.
 *
 * Creates a PullRequest node, a TARGETS_REPO edge to the Repo node,
 * and a CHANGES edge to each File node touched by the PR.
 * The CHANGES edge carries the full change details: status, line counts,
 * unified diff patch, and previous path (for renames).
 */

import type {
  GraphStore,
  ImportBatchRequest,
  SourceFile,
} from '../store/types';
import type { PRDetail, PRFileDiff } from './types';
import type { RepoMeta } from './types';

/** Max characters of unified diff to store per file edge. */
const MAX_PATCH_CHARS = 5000;

function truncatePatch(patch: string | undefined): string | undefined {
  if (!patch) return undefined;
  if (patch.length <= MAX_PATCH_CHARS) return patch;
  return (
    patch.slice(0, MAX_PATCH_CHARS) +
    `\n... [truncated, ${patch.length} chars total]`
  );
}

function buildChangeProperties(file: PRFileDiff): Record<string, unknown> {
  const props: Record<string, unknown> = {
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    path: file.path,
  };
  if (file.patch) {
    props.patch = truncatePatch(file.patch);
  }
  if (file.previous_path) {
    props.previous_path = file.previous_path;
  }
  return props;
}

export async function indexPRIntoGraph(
  store: GraphStore,
  pr: PRDetail,
  meta: RepoMeta,
): Promise<{ nodes_created: number; relationships_created: number }> {
  const repoId = `${meta.owner}/${meta.repo}`;
  const prId = `${repoId}/pr/${pr.number}`;

  const batch: ImportBatchRequest = {
    nodes: [
      {
        id: prId,
        type: 'PullRequest',
        name: `#${pr.number}: ${pr.title}`,
        properties: {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.author,
          url: pr.url,
          created_at: pr.created_at,
          base_branch: pr.base_branch,
          head_branch: pr.head_branch,
          additions: pr.additions,
          deletions: pr.deletions,
          files_changed: pr.files.length,
        },
      },
    ],
    relationships: [
      {
        id: `${prId}->repo:${repoId}`,
        type: 'TARGETS_REPO',
        source_id: prId,
        target_id: repoId,
      },
    ],
  };

  // Collect all directory paths we need to ensure exist.
  // Use a Set to avoid creating duplicate nodes/edges.
  const ensuredDirs = new Set<string>();

  for (const file of pr.files) {
    const fileId = `${repoId}/${file.path}`;

    // Ensure the File node exists — the store uses MERGE so this is
    // safe even if the file was already indexed during repo ingestion.
    // Use basename as name to match the code indexer convention.
    const fileName = file.path.split('/').pop() || file.path;
    batch.nodes.push({
      id: fileId,
      type: 'File',
      name: fileName,
      properties: { path: file.path },
    });

    // Ensure the full directory chain exists so defined_in edges connect.
    // Walk from the file's parent dir up to the repo root.
    const parts = file.path.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
      const dirPath = parts.slice(0, i).join('/');
      if (ensuredDirs.has(dirPath)) break; // ancestors already handled
      ensuredDirs.add(dirPath);

      const dirId = `${repoId}/${dirPath}`;
      const dirName = dirPath.split('/').pop() || dirPath;
      batch.nodes.push({
        id: dirId,
        type: 'Directory',
        name: dirName,
        properties: { path: dirPath },
      });

      // Link directory to its parent (or repo root)
      const parentDirPath = parts.slice(0, i - 1).join('/');
      const parentId = parentDirPath ? `${repoId}/${parentDirPath}` : repoId;
      batch.relationships.push({
        id: `${dirId}->defined_in->${parentId}`,
        type: 'defined_in',
        source_id: dirId,
        target_id: parentId,
      });
    }

    // Link file to its immediate parent directory (or repo root)
    const lastSlash = file.path.lastIndexOf('/');
    const parentId =
      lastSlash > 0 ? `${repoId}/${file.path.slice(0, lastSlash)}` : repoId;
    batch.relationships.push({
      id: `${fileId}->defined_in->${parentId}`,
      type: 'defined_in',
      source_id: fileId,
      target_id: parentId,
    });

    batch.relationships.push({
      id: `${prId}->changes:${fileId}`,
      type: 'CHANGES',
      source_id: prId,
      target_id: fileId,
      properties: buildChangeProperties(file),
    });
  }

  const result = await store.importBatch(batch);

  // Store the PR body as source content so it's accessible via load_source
  if (pr.body) {
    const sources: SourceFile[] = [
      { id: prId, path: `PR #${pr.number}`, content: pr.body },
    ];
    store.storeSource(sources);
  }

  return result;
}

export async function indexMultiplePRs(
  store: GraphStore,
  prs: PRDetail[],
  meta: RepoMeta,
): Promise<{ nodes_created: number; relationships_created: number }> {
  let totalNodes = 0;
  let totalRels = 0;

  for (const pr of prs) {
    const result = await indexPRIntoGraph(store, pr, meta);
    totalNodes += result.nodes_created;
    totalRels += result.relationships_created;
  }

  return { nodes_created: totalNodes, relationships_created: totalRels };
}
