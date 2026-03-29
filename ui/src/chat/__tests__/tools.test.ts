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
import { makeGraphTools } from '../tools';
import { createMockStore } from '../../__tests__/mockStore';

describe('makeGraphTools', () => {
  it('returns 6 tools', () => {
    const store = createMockStore();
    const tools = makeGraphTools(store);
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'search_graph',
      'list_nodes',
      'get_node',
      'traverse_graph',
      'load_source',
      'explore_node',
    ]);
  });

  describe('search_graph', () => {
    it('splits comma-separated nodeTypes', async () => {
      const store = createMockStore();
      const tools = makeGraphTools(store);
      const searchTool = tools.find((t) => t.name === 'search_graph')!;
      await searchTool.invoke({
        query: 'auth',
        nodeTypes: 'Repository, Class',
      });
      expect(store.searchNodes).toHaveBeenCalledWith('auth', undefined, [
        'Repository',
        'Class',
      ]);
    });
  });

  describe('get_node', () => {
    it('returns node JSON when found', async () => {
      const node = { id: 'n1', type: 'Repository', name: 'Auth' };
      const store = createMockStore({
        getNode: vi.fn().mockResolvedValue(node),
      });
      const tools = makeGraphTools(store);
      const getTool = tools.find((t) => t.name === 'get_node')!;
      const result = await getTool.invoke({ nodeId: 'n1' });
      expect(JSON.parse(result as string)).toMatchObject({ id: 'n1' });
    });

    it('returns error JSON when null', async () => {
      const store = createMockStore();
      const tools = makeGraphTools(store);
      const getTool = tools.find((t) => t.name === 'get_node')!;
      const result = await getTool.invoke({ nodeId: 'missing' });
      expect(JSON.parse(result as string)).toMatchObject({
        error: 'Node not found',
      });
    });
  });

  describe('load_source', () => {
    it('returns source content', async () => {
      const store = createMockStore({
        fetchSource: vi.fn().mockResolvedValue({
          path: 'src/main.ts',
          content: 'console.log("hi")',
          line_count: 1,
        }),
      });
      const tools = makeGraphTools(store);
      const loadTool = tools.find((t) => t.name === 'load_source')!;
      const result = await loadTool.invoke({
        nodeId: 'owner/repo/src/main.ts',
      });
      expect(JSON.parse(result as string)).toMatchObject({
        path: 'src/main.ts',
      });
    });

    it('truncates at MAX_SOURCE_CHARS (8000)', async () => {
      const bigContent = 'x'.repeat(10000);
      const store = createMockStore({
        fetchSource: vi.fn().mockResolvedValue({
          path: 'big.ts',
          content: bigContent,
          line_count: 100,
        }),
      });
      const tools = makeGraphTools(store);
      const loadTool = tools.find((t) => t.name === 'load_source')!;
      const result = (await loadTool.invoke({ nodeId: 'big.ts' })) as string;
      const parsed = JSON.parse(result);
      expect(parsed.truncated).toBe(true);
      expect(result.length).toBeLessThan(bigContent.length);
    });
  });

  describe('truncation', () => {
    it('truncates results exceeding MAX_RESULT_CHARS (4000)', async () => {
      const bigResults = Array.from({ length: 200 }, (_, i) => ({
        id: `n${i}`,
        type: 'Repository',
        name: `LongRepoName${i}${'x'.repeat(20)}`,
      }));
      const store = createMockStore({
        searchNodes: vi.fn().mockResolvedValue(bigResults),
      });
      const tools = makeGraphTools(store);
      const searchTool = tools.find((t) => t.name === 'search_graph')!;
      const result = (await searchTool.invoke({ query: 'x' })) as string;
      const parsed = JSON.parse(result);
      expect(parsed.truncated).toBe(true);
      expect(parsed.results.length).toBeLessThan(200);
    });
  });
});
