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

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { GraphLink } from '../../graph/types';
import {
  LayoutLinkCollector,
  pickAssignments,
  type LayoutLink,
} from '../useForceLayout3d';

const RELATIONAL_LINK_WEIGHT = 0.05;

const link = (
  source: string,
  target: string,
  label = 'DEFINES',
): GraphLink => ({
  source,
  target,
  label,
});

const isStructural = (l: GraphLink) => l.label === 'DEFINES';

// ─── Reference implementation: the OLD buildLayoutLinks + takeUnsentLinks ──
// The collector must produce byte-identical output (content AND order) to
// this pair on every step of any sequence — the fast path is an optimization
// only.

function referenceBuildLayoutLinks(
  nodeIdSet: Set<string>,
  links: GraphLink[],
): LayoutLink[] {
  const out: LayoutLink[] = [];
  for (const l of links) {
    const source = typeof l.source === 'string' ? l.source : l.source.id;
    const target = typeof l.target === 'string' ? l.target : l.target.id;
    if (source === target) continue;
    if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) continue;
    out.push({
      source,
      target,
      w: isStructural(l) ? 1 : RELATIONAL_LINK_WEIGHT,
    });
  }
  return out;
}

function referenceTakeUnsentLinks(
  links: LayoutLink[],
  sent: Map<string, number>,
): LayoutLink[] {
  const counts = new Map<string, number>();
  const out: LayoutLink[] = [];
  for (const l of links) {
    const key = `${l.source}|${l.target}`;
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);
    if (c > (sent.get(key) ?? 0)) {
      out.push(l);
      sent.set(key, c);
    }
  }
  return out;
}

/** Drives collector + reference through the same step sequence, asserting
 *  identical output at each step. */
class EquivalenceHarness {
  collector = new LayoutLinkCollector();
  refSent = new Map<string, number>();

  reset(): void {
    this.collector.reset();
    this.refSent = new Map();
  }

  step(allLinks: GraphLink[], nodeIds: string[]): LayoutLink[] {
    const nodeIdSet = new Set(nodeIds);
    const expected = referenceTakeUnsentLinks(
      referenceBuildLayoutLinks(nodeIdSet, allLinks),
      this.refSent,
    );
    const actual = this.collector.collect(allLinks, nodeIdSet, isStructural);
    expect(actual).toEqual(expected);
    return actual;
  }
}

describe('LayoutLinkCollector', () => {
  it('returns the full filtered list after reset (worker-init payload)', () => {
    const h = new EquivalenceHarness();
    h.reset();
    const out = h.step(
      [link('a', 'b'), link('b', 'c', 'CALLS'), link('a', 'a')],
      ['a', 'b', 'c'],
    );
    expect(out).toEqual([
      { source: 'a', target: 'b', w: 1 },
      { source: 'b', target: 'c', w: RELATIONAL_LINK_WEIGHT },
    ]);
  });

  it('emits only the suffix links across append-only batches', () => {
    const h = new EquivalenceHarness();
    h.reset();
    const batch1 = [link('a', 'b')];
    h.step(batch1, ['a', 'b']);
    const batch2 = batch1.concat([link('b', 'c')]);
    const out = h.step(batch2, ['a', 'b', 'c']);
    expect(out).toEqual([{ source: 'b', target: 'c', w: 1 }]);
  });

  it('catches late resolve edges between nodes from earlier batches', () => {
    const h = new EquivalenceHarness();
    h.reset();
    const batch1 = [link('a', 'b')];
    h.step(batch1, ['a', 'b']);
    // Same node set, link-only flush with a relational edge between OLD nodes.
    const batch2 = batch1.concat([link('a', 'b', 'CALLS')]);
    const out = h.step(batch2, ['a', 'b']);
    expect(out).toEqual([
      { source: 'a', target: 'b', w: RELATIONAL_LINK_WEIGHT },
    ]);
  });

  it('preserves multiset semantics: a repeated source|target pair is re-sent', () => {
    const h = new EquivalenceHarness();
    h.reset();
    // Two links between the same endpoints with different labels share the
    // (label-less) diff key — both must reach the worker as spring links.
    const batch1 = [link('a', 'b', 'DEFINES')];
    h.step(batch1, ['a', 'b']);
    const batch2 = batch1.concat([link('a', 'b', 'IMPORTS')]);
    const out = h.step(batch2, ['a', 'b']);
    expect(out).toHaveLength(1);
    expect(out[0].w).toBe(RELATIONAL_LINK_WEIGHT);
  });

  it('defers links with a missing endpoint and emits them when the node arrives', () => {
    const h = new EquivalenceHarness();
    h.reset();
    // Progressive loading: the edge arrives before its target node.
    const batch1 = [link('a', 'b'), link('b', 'ghost')];
    const out1 = h.step(batch1, ['a', 'b']);
    expect(out1).toEqual([{ source: 'a', target: 'b', w: 1 }]);
    // Node set grows to include the endpoint; links array unchanged. The old
    // full rescan caught the now-resolvable PREFIX link — so must we.
    const out2 = h.step(batch1, ['a', 'b', 'ghost']);
    expect(out2).toEqual([{ source: 'b', target: 'ghost', w: 1 }]);
    // And it is not re-emitted afterwards.
    expect(h.step(batch1, ['a', 'b', 'ghost'])).toEqual([]);
  });

  it('never emits self-loops', () => {
    const h = new EquivalenceHarness();
    h.reset();
    const links = [link('a', 'a'), link('a', 'b')];
    expect(h.step(links, ['a', 'b'])).toEqual([
      { source: 'a', target: 'b', w: 1 },
    ]);
    expect(h.step(links.concat([link('b', 'b')]), ['a', 'b'])).toEqual([]);
  });

  it('re-running the same list emits nothing (StrictMode double-run)', () => {
    const h = new EquivalenceHarness();
    h.reset();
    const links = [link('a', 'b'), link('b', 'c')];
    h.step(links, ['a', 'b', 'c']);
    expect(h.step(links, ['a', 'b', 'c'])).toEqual([]);
  });

  it('falls back safely when the array is replaced (reload with fresh objects)', () => {
    const h = new EquivalenceHarness();
    h.reset();
    h.step([link('a', 'b')], ['a', 'b']);
    const replaced = [link('a', 'b'), link('b', 'c')];
    expect(h.step(replaced, ['a', 'b', 'c'])).toEqual([
      { source: 'b', target: 'c', w: 1 },
    ]);
  });

  it('does NOT over-emit after a shrink/regrow that fools the prefix check', () => {
    const h = new EquivalenceHarness();
    h.reset();
    const full = [link('a', 'b'), link('a', 'b', 'IMPORTS'), link('b', 'c')];
    h.step(full, ['a', 'b', 'c']);
    // A filter shrinks the list to a prefix of itself (element identity kept):
    // sent counts now EXCEED the current list — fast path must stay disabled.
    const shrunk = full.slice(0, 1);
    expect(h.step(shrunk, ['a', 'b', 'c'])).toEqual([]);
    // Regrow by appending onto the shrunk array. The tracker's boundary check
    // passes (it IS an append of `shrunk`), but the sent-superset makes the
    // fast path unsound — the collector must full-scan and, like the old
    // code, emit nothing for the re-appearing pair.
    const regrown = shrunk.concat([link('a', 'b', 'IMPORTS')]);
    expect(h.step(regrown, ['a', 'b', 'c'])).toEqual([]);
    // Growing further: b→c re-appears (already sent once — stays deduped by
    // the multiset diff) and c→d is genuinely new. Once the list catches back
    // up to the sent counts, later appends fast-path again.
    const regrown2 = regrown.concat([link('b', 'c'), link('c', 'd')]);
    expect(h.step(regrown2, ['a', 'b', 'c', 'd'])).toEqual([
      { source: 'c', target: 'd', w: 1 },
    ]);
    const regrown3 = regrown2.concat([link('d', 'e')]);
    expect(h.step(regrown3, ['a', 'b', 'c', 'd', 'e'])).toEqual([
      { source: 'd', target: 'e', w: 1 },
    ]);
  });

  it('stays equivalent across a randomized append-heavy sequence', () => {
    const h = new EquivalenceHarness();
    h.reset();
    // Deterministic pseudo-random sequence (LCG) so failures reproduce.
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const nodeIds: string[] = [];
    let links: GraphLink[] = [];
    for (let step = 0; step < 40; step++) {
      // Add 0-3 nodes.
      const newCount = Math.floor(rnd() * 4);
      for (let i = 0; i < newCount; i++) nodeIds.push(`n${nodeIds.length}`);
      // Append 0-4 links, sometimes to not-yet-existing nodes.
      const batch: GraphLink[] = [];
      const linkCount = Math.floor(rnd() * 5);
      for (let i = 0; i < linkCount; i++) {
        const s = `n${Math.floor(rnd() * (nodeIds.length + 2))}`;
        const t = `n${Math.floor(rnd() * (nodeIds.length + 2))}`;
        batch.push(link(s, t, rnd() < 0.5 ? 'DEFINES' : 'CALLS'));
      }
      links = links.concat(batch);
      h.step(links, nodeIds); // asserts equivalence internally
    }
  });
});

describe('pickAssignments', () => {
  it('returns only the requested ids that have assignments', () => {
    const assignments = { a: 1, b: 2, c: 3 };
    expect(pickAssignments(assignments, ['a', 'c', 'missing'])).toEqual({
      a: 1,
      c: 3,
    });
  });

  it('returns an empty record when assignments are stale (streaming)', () => {
    expect(pickAssignments({}, ['a', 'b'])).toEqual({});
  });

  it('keeps community id 0 (falsy value)', () => {
    expect(pickAssignments({ a: 0 }, ['a'])).toEqual({ a: 0 });
  });
});
