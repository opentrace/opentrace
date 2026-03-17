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

import { describe, it, expect } from 'vitest';
import { InMemoryGraphStore } from '../inMemoryStore';

describe('InMemoryGraphStore', () => {
  describe('importBatch property merging', () => {
    it('merges properties when importing a node with an existing ID', async () => {
      const store = new InMemoryGraphStore();

      // First import: node with structural properties
      await store.importBatch({
        nodes: [
          {
            id: 'file::func',
            type: 'Function',
            name: 'getUserById',
            properties: { language: 'python', start_line: 1, end_line: 5 },
          },
        ],
        relationships: [],
      });

      // Second import: same ID with summary (simulates pipeline summary update)
      await store.importBatch({
        nodes: [
          {
            id: 'file::func',
            type: 'Function',
            name: 'getUserById',
            properties: { summary: 'Retrieves user by ID' },
          },
        ],
        relationships: [],
      });

      // Fetch the node and verify both sets of properties are present
      const result = await store.getNode('file::func');
      expect(result).toBeDefined();
      expect(result!.properties.language).toBe('python');
      expect(result!.properties.start_line).toBe(1);
      expect(result!.properties.end_line).toBe(5);
      expect(result!.properties.summary).toBe('Retrieves user by ID');
    });

    it('does not double-count merged nodes', async () => {
      const store = new InMemoryGraphStore();

      const first = await store.importBatch({
        nodes: [
          {
            id: 'n1',
            type: 'File',
            name: 'a.py',
            properties: { path: 'a.py' },
          },
        ],
        relationships: [],
      });
      expect(first.nodes_created).toBe(1);

      const second = await store.importBatch({
        nodes: [
          {
            id: 'n1',
            type: 'File',
            name: 'a.py',
            properties: { summary: 'File a' },
          },
        ],
        relationships: [],
      });
      // Merging an existing node should not count as a new creation
      expect(second.nodes_created).toBe(0);
    });

    it('preserves original properties when merging', async () => {
      const store = new InMemoryGraphStore();

      await store.importBatch({
        nodes: [
          {
            id: 'n1',
            type: 'Class',
            name: 'Foo',
            properties: {
              language: 'go',
              start_line: 10,
              docs: 'Foo does things',
            },
          },
        ],
        relationships: [],
      });

      // Merge with overlapping + new properties
      await store.importBatch({
        nodes: [
          {
            id: 'n1',
            type: 'Class',
            name: 'Foo',
            properties: { summary: 'Foo class', language: 'go' },
          },
        ],
        relationships: [],
      });

      const result = await store.getNode('n1');
      expect(result!.properties).toEqual({
        language: 'go',
        start_line: 10,
        docs: 'Foo does things',
        summary: 'Foo class',
      });
    });
  });
});
