import { describe, it, expect, vi } from 'vitest';
import { makePRTools } from '../prTools';
import { createMockStore } from '../../__tests__/mockStore';
import type { PRClient } from '../../pr/client';

function createMockPRClient(
  overrides?: Partial<Record<keyof PRClient, unknown>>,
): PRClient {
  return {
    meta: { provider: 'github', owner: 'o', repo: 'r' },
    listPRs: vi.fn().mockResolvedValue([]),
    getPRDetail: vi.fn().mockResolvedValue({}),
    createReview: vi.fn().mockResolvedValue(undefined),
    getFileContent: vi.fn().mockResolvedValue('file content'),
    postComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PRClient;
}

describe('makePRTools', () => {
  it('returns 4 tools without prClient', () => {
    const tools = makePRTools(createMockStore());
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name);
    expect(names).toContain('list_pull_requests');
    expect(names).toContain('get_pull_request');
    expect(names).toContain('summarize_pr_changes');
    expect(names).toContain('get_pr_file_change');
  });

  it('returns 7 tools with prClient', () => {
    const tools = makePRTools(createMockStore(), createMockPRClient());
    expect(tools).toHaveLength(7);
    const names = tools.map((t) => t.name);
    expect(names).toContain('submit_review_summary');
    expect(names).toContain('comment_on_pr');
    expect(names).toContain('suggest_comment');
  });

  describe('get_pr_file_change', () => {
    const prId = 'owner/repo/pr/1';
    const filePath = 'src/main.ts';
    const traverseResult = [
      {
        node: { id: 'f1', type: 'File', name: 'main.ts' },
        relationship: {
          id: 'r1',
          type: 'CHANGES',
          source_id: prId,
          target_id: 'f1',
          properties: {
            path: filePath,
            status: 'modified',
            additions: 5,
            deletions: 2,
            patch: '@@ -1,3 +1,5 @@\n+added line',
          },
        },
        depth: 1,
      },
    ];

    it('version "diff" returns patch', async () => {
      const store = createMockStore({
        traverse: vi.fn().mockResolvedValue(traverseResult),
        getNode: vi.fn().mockResolvedValue({
          id: prId,
          type: 'PullRequest',
          name: '#1',
          properties: { base_branch: 'main', head_branch: 'feat' },
        }),
      });
      const tools = makePRTools(store);
      const tool = tools.find((t) => t.name === 'get_pr_file_change')!;
      const result = JSON.parse(
        (await tool.invoke({ prId, filePath, version: 'diff' })) as string,
      );
      expect(result.diff).toContain('+added line');
    });

    it('version "base" + status "added" returns null base_content', async () => {
      const addedResult = [
        {
          ...traverseResult[0],
          relationship: {
            ...traverseResult[0].relationship,
            properties: {
              ...traverseResult[0].relationship.properties,
              status: 'added',
            },
          },
        },
      ];
      const store = createMockStore({
        traverse: vi.fn().mockResolvedValue(addedResult),
        getNode: vi.fn().mockResolvedValue({
          id: prId,
          type: 'PullRequest',
          name: '#1',
          properties: { base_branch: 'main', head_branch: 'feat' },
        }),
      });
      const tools = makePRTools(store);
      const tool = tools.find((t) => t.name === 'get_pr_file_change')!;
      const result = JSON.parse(
        (await tool.invoke({ prId, filePath, version: 'base' })) as string,
      );
      expect(result.base_content).toBeNull();
    });

    it('version "new" + status "removed" returns null new_content', async () => {
      const removedResult = [
        {
          ...traverseResult[0],
          relationship: {
            ...traverseResult[0].relationship,
            properties: {
              ...traverseResult[0].relationship.properties,
              status: 'removed',
            },
          },
        },
      ];
      const store = createMockStore({
        traverse: vi.fn().mockResolvedValue(removedResult),
        getNode: vi.fn().mockResolvedValue({
          id: prId,
          type: 'PullRequest',
          name: '#1',
          properties: {},
        }),
      });
      const tools = makePRTools(store);
      const tool = tools.find((t) => t.name === 'get_pr_file_change')!;
      const result = JSON.parse(
        (await tool.invoke({ prId, filePath, version: 'new' })) as string,
      );
      expect(result.new_content).toBeNull();
    });

    it('falls back to store.fetchSource when no prClient for base version', async () => {
      const store = createMockStore({
        traverse: vi.fn().mockResolvedValue(traverseResult),
        getNode: vi.fn().mockResolvedValue({
          id: prId,
          type: 'PullRequest',
          name: '#1',
          properties: { base_branch: 'main' },
        }),
        fetchSource: vi.fn().mockResolvedValue({
          content: 'original code',
          path: 'src/main.ts',
          line_count: 1,
        }),
      });
      const tools = makePRTools(store); // no prClient
      const tool = tools.find((t) => t.name === 'get_pr_file_change')!;
      const result = JSON.parse(
        (await tool.invoke({ prId, filePath, version: 'base' })) as string,
      );
      expect(result.base_content).toBe('original code');
    });

    it('calls prClient.getFileContent when available', async () => {
      const prClient = createMockPRClient();
      const store = createMockStore({
        traverse: vi.fn().mockResolvedValue(traverseResult),
        getNode: vi.fn().mockResolvedValue({
          id: prId,
          type: 'PullRequest',
          name: '#1',
          properties: { base_branch: 'main', head_branch: 'feat' },
        }),
      });
      const tools = makePRTools(store, prClient);
      const tool = tools.find((t) => t.name === 'get_pr_file_change')!;
      await tool.invoke({ prId, filePath, version: 'base' });
      expect(prClient.getFileContent).toHaveBeenCalledWith(filePath, 'main');
    });
  });

  describe('submit_review_summary', () => {
    it('calls prClient.createReview', async () => {
      const prClient = createMockPRClient();
      const tools = makePRTools(createMockStore(), prClient);
      const tool = tools.find((t) => t.name === 'submit_review_summary')!;
      const result = JSON.parse(
        (await tool.invoke({
          number: 42,
          body: 'LGTM',
          event: 'APPROVE',
        })) as string,
      );
      expect(result.success).toBe(true);
      expect(prClient.createReview).toHaveBeenCalledWith(42, 'LGTM', 'APPROVE');
    });

    it('returns error JSON on exception', async () => {
      const prClient = createMockPRClient({
        createReview: vi.fn().mockRejectedValue(new Error('Token expired')),
      });
      const tools = makePRTools(createMockStore(), prClient);
      const tool = tools.find((t) => t.name === 'submit_review_summary')!;
      const result = JSON.parse(
        (await tool.invoke({
          number: 1,
          body: 'x',
          event: 'COMMENT',
        })) as string,
      );
      expect(result.error).toBe('Token expired');
    });
  });

  describe('comment_on_pr', () => {
    it('returns pending_approval payload', async () => {
      const tools = makePRTools(createMockStore(), createMockPRClient());
      const tool = tools.find((t) => t.name === 'comment_on_pr')!;
      const result = JSON.parse(
        (await tool.invoke({ number: 5, body: 'Nice work' })) as string,
      );
      expect(result.pending_approval).toBe(true);
      expect(result.body).toBe('Nice work');
    });
  });
});
