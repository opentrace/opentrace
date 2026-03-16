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
import { buildGraphContext } from '../graphContext';
import type { GraphNode, GraphLink } from '../../types/graph';

function makeNodes(types: string[]): GraphNode[] {
  return types.map((t, i) => ({ id: `n${i}`, name: `Node${i}`, type: t }));
}

function makeLink(src: string, tgt: string, label?: string): GraphLink {
  return { source: src, target: tgt, label: label || '' };
}

describe('buildGraphContext', () => {
  it('returns string with correct node and link counts', () => {
    const nodes = makeNodes(['Repository', 'Class']);
    const links = [makeLink('n0', 'n1', 'READS')];
    const ctx = buildGraphContext(nodes, links);
    expect(ctx).toContain('2 nodes');
    expect(ctx).toContain('1 relationships');
  });

  it('sorts type distribution descending by count', () => {
    const nodes = makeNodes([
      'File',
      'File',
      'File',
      'Repository',
      'Repository',
      'Class',
    ]);
    const ctx = buildGraphContext(nodes, []);
    const typeSection = ctx.split('Node types:\n')[1].split('\n\n')[0];
    const lines = typeSection.split('\n').map((l) => l.trim());
    expect(lines[0]).toMatch(/^File: 3$/);
    expect(lines[1]).toMatch(/^Repository: 2$/);
    expect(lines[2]).toMatch(/^Class: 1$/);
  });

  it('uses RELATES as fallback label for links without label', () => {
    const nodes = makeNodes(['Repository']);
    const links = [makeLink('n0', 'n0', '')];
    const ctx = buildGraphContext(nodes, links);
    expect(ctx).toContain('RELATES');
  });

  it('caps sample nodes at 30', () => {
    const nodes = makeNodes(Array.from({ length: 50 }, () => 'Repository'));
    const ctx = buildGraphContext(nodes, []);
    const sampleSection = ctx.split('Sample nodes:\n')[1].split('\n\n')[0];
    const sampleLines = sampleSection
      .split('\n')
      .filter((l) => l.includes(' - '));
    expect(sampleLines.length).toBeLessThanOrEqual(30);
  });

  it('caps sample relationships at 20', () => {
    const nodes = makeNodes(['Repository', 'Class']);
    const links = Array.from({ length: 30 }, (_, i) =>
      makeLink('n0', 'n1', `REL${i}`),
    );
    const ctx = buildGraphContext(nodes, links);
    const relSection = ctx.split('Sample relationships:\n')[1];
    const relLines = relSection.split('\n').filter((l) => l.includes(' - '));
    expect(relLines.length).toBeLessThanOrEqual(20);
  });

  it('handles source/target as object with name/id', () => {
    const nodes = makeNodes(['Repository', 'Class']);
    const link = {
      source: {
        id: 'n0',
        name: 'Auth',
        type: 'Repository',
      } as unknown as string,
      target: { id: 'n1', name: 'DB', type: 'Class' } as unknown as string,
      label: 'READS',
    };
    const ctx = buildGraphContext(nodes, [link]);
    expect(ctx).toContain('Auth -[READS]-> DB');
  });

  it('handles empty arrays gracefully', () => {
    const ctx = buildGraphContext([], []);
    expect(ctx).toContain('0 nodes');
    expect(ctx).toContain('0 relationships');
  });
});
