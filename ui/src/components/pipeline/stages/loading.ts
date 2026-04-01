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

import type { GraphNode, GraphRelationship } from '../types';

const LANGUAGE_MAP: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
};

export function getExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot === path.length - 1) return '';
  return path.slice(dot);
}

export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return '';
  return path.slice(0, slash);
}

export function detectLanguage(ext: string): string | null {
  return LANGUAGE_MAP[ext] ?? null;
}

export function ensureDirChain(
  repoId: string,
  dirPath: string,
  dirNodes: Map<string, GraphNode>,
  rels: GraphRelationship[],
): void {
  if (!dirPath || dirNodes.has(dirPath)) return;

  const parent = parentDir(dirPath);
  ensureDirChain(repoId, parent, dirNodes, rels);

  const dirId = `${repoId}/${dirPath}`;
  const name = dirPath.includes('/')
    ? dirPath.slice(dirPath.lastIndexOf('/') + 1)
    : dirPath;

  dirNodes.set(dirPath, {
    id: dirId,
    type: 'Directory',
    name,
    properties: { path: dirPath },
  });

  const targetId = parent ? `${repoId}/${parent}` : repoId;
  rels.push({
    id: `${dirId}->DEFINES->${targetId}`,
    type: 'DEFINES',
    source_id: dirId,
    target_id: targetId,
  });
}
