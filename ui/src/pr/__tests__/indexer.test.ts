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

import { describe, it, expect, vi } from 'vitest';
import { indexPRIntoGraph, indexMultiplePRs } from '../indexer';
import { createMockStore } from '../../__tests__/mockStore';
import type { PRDetail } from '../types';
import type { RepoMeta } from '../types';

const meta: RepoMeta = { provider: 'github', owner: 'owner', repo: 'repo' };

function makePR(overrides?: Partial<PRDetail>): PRDetail {
  return {
    number: 42,
    title: 'Test PR',
    state: 'open',
    author: 'dev',
    url: 'https://github.com/owner/repo/pull/42',
    created_at: '2025-01-01',
    updated_at: '2025-01-02',
    base_branch: 'main',
    head_branch: 'feature',
    additions: 10,
    deletions: 5,
    body: 'PR description',
    files: [
      {
        path: 'src/main.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        patch: '@@ -1,3 +1,5 @@\n+added',
      },
      {
        path: 'src/utils/helper.ts',
        status: 'added',
        additions: 10,
        deletions: 0,
      },
    ],
    comments_count: 0,
    review_comments_count: 0,
    ...overrides,
  };
}

describe('indexPRIntoGraph', () => {
  it('creates PullRequest node with correct ID pattern', async () => {
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 5,
        relationships_created: 4,
      }),
    });
    await indexPRIntoGraph(store, makePR(), meta);

    const batch = (store.importBatch as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const prNode = batch.nodes.find(
      (n: { type: string }) => n.type === 'PullRequest',
    );
    expect(prNode.id).toBe('owner/repo/pr/42');
    expect(prNode.name).toBe('#42: Test PR');
  });

  it('creates TARGETS_REPO edge to Repo node', async () => {
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 0,
        relationships_created: 0,
      }),
    });
    await indexPRIntoGraph(store, makePR(), meta);

    const batch = (store.importBatch as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const repoEdge = batch.relationships.find(
      (r: { type: string }) => r.type === 'TARGETS_REPO',
    );
    expect(repoEdge.target_id).toBe('owner/repo');
  });

  it('creates File nodes with basename as name', async () => {
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 0,
        relationships_created: 0,
      }),
    });
    await indexPRIntoGraph(store, makePR(), meta);

    const batch = (store.importBatch as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const fileNodes = batch.nodes.filter(
      (n: { type: string }) => n.type === 'File',
    );
    expect(fileNodes).toHaveLength(2);
    expect(fileNodes[0].name).toBe('main.ts');
  });

  it('creates CHANGES edges with correct properties', async () => {
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 0,
        relationships_created: 0,
      }),
    });
    await indexPRIntoGraph(store, makePR(), meta);

    const batch = (store.importBatch as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const changesEdges = batch.relationships.filter(
      (r: { type: string }) => r.type === 'CHANGES',
    );
    expect(changesEdges).toHaveLength(2);
    expect(changesEdges[0].properties).toMatchObject({
      status: 'modified',
      additions: 5,
      deletions: 2,
      path: 'src/main.ts',
    });
  });

  it('truncates patch at MAX_PATCH_CHARS (5000)', async () => {
    const longPatch = 'x'.repeat(6000);
    const pr = makePR({
      files: [
        {
          path: 'big.ts',
          status: 'modified',
          additions: 100,
          deletions: 50,
          patch: longPatch,
        },
      ],
    });
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 0,
        relationships_created: 0,
      }),
    });
    await indexPRIntoGraph(store, pr, meta);

    const batch = (store.importBatch as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const changesEdge = batch.relationships.find(
      (r: { type: string }) => r.type === 'CHANGES',
    );
    expect(changesEdge.properties.patch.length).toBeLessThan(longPatch.length);
    expect(changesEdge.properties.patch).toContain('truncated');
  });

  it('creates directory chain with deduplication', async () => {
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 0,
        relationships_created: 0,
      }),
    });
    await indexPRIntoGraph(store, makePR(), meta);

    const batch = (store.importBatch as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const dirNodes = batch.nodes.filter(
      (n: { type: string }) => n.type === 'Directory',
    );
    // src, src/utils — 'src' should appear only once even though two files use it
    const srcDirs = dirNodes.filter(
      (n: { properties?: { path: string } }) => n.properties?.path === 'src',
    );
    expect(srcDirs).toHaveLength(1);
  });

  it('includes previous_path for renamed files', async () => {
    const pr = makePR({
      files: [
        {
          path: 'src/new.ts',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          previous_path: 'src/old.ts',
        },
      ],
    });
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 0,
        relationships_created: 0,
      }),
    });
    await indexPRIntoGraph(store, pr, meta);

    const batch = (store.importBatch as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    const changesEdge = batch.relationships.find(
      (r: { type: string }) => r.type === 'CHANGES',
    );
    expect(changesEdge.properties.previous_path).toBe('src/old.ts');
  });

  it('stores PR body via storeSource, skips when empty', async () => {
    const store = createMockStore({
      importBatch: vi.fn().mockResolvedValue({
        nodes_created: 0,
        relationships_created: 0,
      }),
    });
    await indexPRIntoGraph(store, makePR(), meta);
    expect(store.storeSource).toHaveBeenCalled();

    // Empty body
    vi.mocked(store.storeSource).mockClear();
    await indexPRIntoGraph(store, makePR({ body: '' }), meta);
    expect(store.storeSource).not.toHaveBeenCalled();
  });
});

describe('indexMultiplePRs', () => {
  it('accumulates totals', async () => {
    const store = createMockStore({
      importBatch: vi
        .fn()
        .mockResolvedValueOnce({ nodes_created: 3, relationships_created: 2 })
        .mockResolvedValueOnce({ nodes_created: 1, relationships_created: 1 }),
    });
    const result = await indexMultiplePRs(
      store,
      [makePR({ number: 1 }), makePR({ number: 2 })],
      meta,
    );
    expect(result.nodes_created).toBe(4);
    expect(result.relationships_created).toBe(3);
  });
});
