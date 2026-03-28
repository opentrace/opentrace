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

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { runPipeline, initParsers } from '../pipeline';
import { MemoryStore } from '../store/memory';
import type { PipelineEvent } from '../types';
import { getPythonParser, makeRepoTree } from './helpers';

beforeAll(async () => {
  const pyParser = await getPythonParser();
  initParsers(new Map([['python', pyParser]]));
});

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'python', 'project');

async function readAllFiles(
  dir: string,
): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await readAllFiles(fullPath)));
    } else {
      results.push({
        path: relative(dir, fullPath),
        content: await readFile(fullPath, 'utf-8'),
      });
    }
  }
  return results;
}

function runAndCollect(
  files: Array<{ path: string; content: string }>,
  opts: { owner: string; repo: string },
  store: MemoryStore,
): PipelineEvent[] {
  const repo = makeRepoTree(files, opts);
  const events: PipelineEvent[] = [];
  for (const event of runPipeline({ repo }, { cancelled: false }, store)) {
    events.push(event);
  }
  return events;
}

describe('cross-repo: same project imported twice with different repo names', () => {
  let store: MemoryStore;
  let files: Array<{ path: string; content: string }>;
  let eventsA: PipelineEvent[];
  let eventsB: PipelineEvent[];

  beforeAll(async () => {
    files = await readAllFiles(fixtureDir);
    store = new MemoryStore();

    eventsA = runAndCollect(
      files,
      { owner: 'org-a', repo: 'user-service' },
      store,
    );
    eventsB = runAndCollect(
      files,
      { owner: 'org-b', repo: 'user-service' },
      store,
    );
  });

  it('both pipelines complete successfully', () => {
    const doneA = eventsA.find((e) => e.kind === 'done');
    const doneB = eventsB.find((e) => e.kind === 'done');
    expect(doneA).toBeDefined();
    expect(doneB).toBeDefined();
  });

  it('store contains nodes from both repos', () => {
    // Both Repository nodes exist
    expect(store.nodes.has('org-a/user-service')).toBe(true);
    expect(store.nodes.has('org-b/user-service')).toBe(true);

    // Same file in both repos
    expect(store.nodes.has('org-a/user-service/db.py')).toBe(true);
    expect(store.nodes.has('org-b/user-service/db.py')).toBe(true);

    // Same class in both repos
    expect(store.nodes.has('org-a/user-service/db.py::Database')).toBe(true);
    expect(store.nodes.has('org-b/user-service/db.py::Database')).toBe(true);
  });

  it('no node ID collisions between repos', () => {
    const aIds = [...store.nodes.keys()].filter((id) =>
      id.startsWith('org-a/'),
    );
    const bIds = [...store.nodes.keys()].filter((id) =>
      id.startsWith('org-b/'),
    );

    // Both repos should produce the same number of repo-scoped nodes
    expect(aIds.length).toBe(bIds.length);
    expect(aIds.length).toBeGreaterThan(0);

    // No overlap
    const overlap = aIds.filter((id) => bIds.includes(id));
    expect(overlap).toEqual([]);
  });

  it('Calls relationships never cross repo boundaries', () => {
    const callRels = [...store.relationships.values()].filter(
      (r) => r.type === 'CALLS',
    );
    expect(callRels.length).toBeGreaterThan(0);

    for (const rel of callRels) {
      const sourceInA = rel.source_id.startsWith('org-a/');
      const targetInA = rel.target_id.startsWith('org-a/');
      const sourceInB = rel.source_id.startsWith('org-b/');
      const targetInB = rel.target_id.startsWith('org-b/');

      // Source and target must be in the same repo
      expect(sourceInA === targetInA).toBe(true);
      expect(sourceInB === targetInB).toBe(true);
    }
  });

  it('Imports relationships never cross repo boundaries', () => {
    const importRels = [...store.relationships.values()].filter(
      (r) => r.type === 'IMPORTS',
    );
    expect(importRels.length).toBeGreaterThan(0);

    for (const rel of importRels) {
      // External packages (pkg:*) don't have a repo prefix — skip those
      if (rel.target_id.startsWith('pkg:')) continue;

      const sourceInA = rel.source_id.startsWith('org-a/');
      const targetInA = rel.target_id.startsWith('org-a/');
      const sourceInB = rel.source_id.startsWith('org-b/');
      const targetInB = rel.target_id.startsWith('org-b/');

      expect(sourceInA === targetInA).toBe(true);
      expect(sourceInB === targetInB).toBe(true);
    }
  });

  it('Defines relationships never cross repo boundaries', () => {
    const definedInRels = [...store.relationships.values()].filter(
      (r) => r.type === 'DEFINES',
    );
    expect(definedInRels.length).toBeGreaterThan(0);

    for (const rel of definedInRels) {
      const sourceInA = rel.source_id.startsWith('org-a/');
      const targetInA = rel.target_id.startsWith('org-a/');
      const sourceInB = rel.source_id.startsWith('org-b/');
      const targetInB = rel.target_id.startsWith('org-b/');

      expect(sourceInA === targetInA).toBe(true);
      expect(sourceInB === targetInB).toBe(true);
    }
  });

  it('all relationship endpoints point to valid nodes', () => {
    for (const rel of store.relationships.values()) {
      expect(store.nodes.has(rel.source_id)).toBe(true);
      expect(store.nodes.has(rel.target_id)).toBe(true);
    }
  });

  it('external packages are shared (not duplicated per repo)', () => {
    // flask Dependency node should appear once, referenced by both repos
    const flaskNodes = [...store.nodes.values()].filter(
      (n) => n.type === 'Dependency' && n.name === 'flask',
    );
    expect(flaskNodes).toHaveLength(1);

    // Both repos should have Imports edges to the flask package
    const flaskImports = [...store.relationships.values()].filter(
      (r) => r.type === 'IMPORTS' && r.target_id === flaskNodes[0].id,
    );
    expect(flaskImports.length).toBeGreaterThanOrEqual(2);
  });

  it('pipeline emits duplicate Dependency nodes across runs (LadybugStore dedup required)', () => {
    // The pipeline has no cross-run state, so each run independently emits
    // shared Dependency nodes like pkg:pypi:flask. This is expected — LadybugStore
    // deduplicates Dependency nodes in flush() to avoid PK violations.
    const allEmittedNodes: { id: string; type: string; from: string }[] = [];

    for (const event of eventsA) {
      if (event.nodes) {
        for (const node of event.nodes) {
          allEmittedNodes.push({ id: node.id, type: node.type, from: 'org-a' });
        }
      }
    }
    for (const event of eventsB) {
      if (event.nodes) {
        for (const node of event.nodes) {
          allEmittedNodes.push({ id: node.id, type: node.type, from: 'org-b' });
        }
      }
    }

    // Find IDs emitted more than once
    const seen = new Map<string, string[]>();
    for (const { id, from } of allEmittedNodes) {
      const sources = seen.get(id);
      if (sources) {
        sources.push(from);
      } else {
        seen.set(id, [from]);
      }
    }

    const duplicates = [...seen.entries()]
      .filter(([, sources]) => sources.length > 1)
      .map(([id, sources]) => ({ id, sources }));

    // Duplicates should only be Dependency nodes — they have global IDs
    // (e.g. pkg:pypi:flask) that collide across repo runs. File/Directory
    // IDs are repo-prefixed and cannot collide.
    expect(duplicates.length).toBeGreaterThan(0);
    for (const dup of duplicates) {
      const node = allEmittedNodes.find((n) => n.id === dup.id);
      expect(node!.type).toBe('Dependency');
    }
  });

  it('duplicate import produces identical call resolution per repo', () => {
    const callRels = [...store.relationships.values()].filter(
      (r) => r.type === 'CALLS',
    );

    const callsA = callRels
      .filter((r) => r.source_id.startsWith('org-a/'))
      .map((r) => ({
        source: r.source_id.replace('org-a/user-service/', ''),
        target: r.target_id.replace('org-a/user-service/', ''),
      }))
      .sort((a, b) =>
        `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`),
      );

    const callsB = callRels
      .filter((r) => r.source_id.startsWith('org-b/'))
      .map((r) => ({
        source: r.source_id.replace('org-b/user-service/', ''),
        target: r.target_id.replace('org-b/user-service/', ''),
      }))
      .sort((a, b) =>
        `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`),
      );

    // Both repos should resolve the exact same call graph
    expect(callsA).toEqual(callsB);
    expect(callsA.length).toBeGreaterThan(0);
  });
});
