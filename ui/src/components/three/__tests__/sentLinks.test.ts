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

import { describe, expect, it } from 'vitest';

import type { GraphLink } from '../../graph/types';
import { renderLinkKey, takeUnsentRenderLinks } from '../sentLinks';

const link = (source: string, target: string, label = 'CALLS'): GraphLink => ({
  source,
  target,
  label,
});

describe('renderLinkKey', () => {
  it('matches the renderer edgeKeySet format (source-label-target)', () => {
    expect(renderLinkKey(link('a', 'b', 'DEFINES'))).toBe('a-DEFINES-b');
  });

  it('resolves object endpoints (d3-mutated links) to their ids', () => {
    const l = {
      source: { id: 'a' },
      target: { id: 'b' },
      label: 'CALLS',
    } as unknown as GraphLink;
    expect(renderLinkKey(l)).toBe('a-CALLS-b');
  });

  it('distinguishes links by label', () => {
    expect(renderLinkKey(link('a', 'b', 'CALLS'))).not.toBe(
      renderLinkKey(link('a', 'b', 'IMPORTS')),
    );
  });
});

describe('takeUnsentRenderLinks', () => {
  it('returns all links on first call and records them as sent', () => {
    const sent = new Set<string>();
    const links = [link('a', 'b'), link('b', 'c')];
    expect(takeUnsentRenderLinks(links, sent)).toEqual(links);
    expect(sent.size).toBe(2);
  });

  it('returns nothing when re-fed the same full link list (same-nodes flush)', () => {
    const sent = new Set<string>();
    const links = [link('a', 'b'), link('b', 'c')];
    takeUnsentRenderLinks(links, sent);
    expect(takeUnsentRenderLinks(links, sent)).toEqual([]);
  });

  it('catches resolve-stage links between nodes from EARLIER batches', () => {
    // Batch 1: nodes a,b and their edge. Batch 2 adds node c — plus a resolve
    // edge a→b whose endpoints BOTH pre-date the batch. An endpoint-membership
    // filter (!prevIds.has(s) || !prevIds.has(t)) would drop it.
    const sent = new Set<string>();
    takeUnsentRenderLinks([link('a', 'b', 'DEFINES')], sent);
    const batch2 = [
      link('a', 'b', 'DEFINES'), // already sent
      link('b', 'c', 'DEFINES'), // touches the new node
      link('a', 'b', 'CALLS'), // late resolve edge, both endpoints old
    ];
    expect(takeUnsentRenderLinks(batch2, sent)).toEqual([
      link('b', 'c', 'DEFINES'),
      link('a', 'b', 'CALLS'),
    ]);
  });

  it('dedups repeated identical links within one batch (renderer dedups by key too)', () => {
    const sent = new Set<string>();
    const out = takeUnsentRenderLinks([link('a', 'b'), link('a', 'b')], sent);
    expect(out).toEqual([link('a', 'b')]);
  });
});
