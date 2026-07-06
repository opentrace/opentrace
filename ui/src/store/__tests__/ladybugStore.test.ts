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
import {
  LadybugGraphStore,
  REL_PAIRS,
  csvFormatValue,
  parquetCellValue,
} from '../ladybugStore';

describe('REL_PAIRS', () => {
  it('has no duplicate FROM→TO pairs', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const [from, to] of REL_PAIRS) {
      const key = `${from}→${to}`;
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });
});

// Helper: build a store with WASM init bypassed and a mock engine whose
// query()/exec() both funnel through one spy, so assertions can inspect every
// Cypher statement the store dispatched (regardless of rows-vs-no-rows).
function makeStoreWithMockEngine() {
  const engineCall = vi.fn().mockResolvedValue([]);
  const engine = {
    init: vi.fn().mockResolvedValue(undefined),
    query: (cypher: string) => engineCall(cypher),
    exec: (cypher: string) => engineCall(cypher),
    fsWrite: vi.fn().mockResolvedValue(undefined),
    fsUnlink: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const store = new LadybugGraphStore(engine);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = store as any;
  s.ready = Promise.resolve();
  return { store, s, connQuery: engineCall };
}

describe('Parquet export → import round-trip fidelity', () => {
  // exportDatabase stringifies every cell via parquetCellValue and
  // importDatabase feeds the strings back through csvFormatValue.
  // Regression: `false` flipped to `true` (truthy non-empty string) and
  // STRING[] columns were erased (string failed Array.isArray).

  it('round-trips BOOL false', () => {
    expect(csvFormatValue(parquetCellValue(false), 'BOOL')).toBe('"false"');
    expect(csvFormatValue(parquetCellValue(true), 'BOOL')).toBe('"true"');
  });

  it('still accepts native booleans', () => {
    expect(csvFormatValue(false, 'BOOL')).toBe('"false"');
    expect(csvFormatValue(true, 'BOOL')).toBe('"true"');
  });

  it('round-trips STRING[] values', () => {
    const cell = parquetCellValue(['Base', 'Mixin']);
    expect(csvFormatValue(cell, 'STRING[]')).toBe('"[""Base"",""Mixin""]"');
    expect(csvFormatValue(parquetCellValue([]), 'STRING[]')).toBe('"[]"');
  });

  it('round-trips STRING[] elements containing commas and quotes', () => {
    const arr = ['Map<string, number>', 'a"b'];
    // The string form coming back from Parquet must format identically to
    // the native array a fresh index would produce.
    expect(csvFormatValue(parquetCellValue(arr), 'STRING[]')).toBe(
      csvFormatValue(arr, 'STRING[]'),
    );
  });

  it('best-effort splits legacy comma-joined STRING[] exports', () => {
    // Old archives hold String(['a','b']) → 'a,b'
    expect(csvFormatValue('Base,Mixin', 'STRING[]')).toBe(
      '"[""Base"",""Mixin""]"',
    );
  });

  it('round-trips numeric columns via String()', () => {
    expect(csvFormatValue(parquetCellValue(42), 'INT32')).toBe('"42"');
    expect(csvFormatValue(parquetCellValue(null), 'INT32')).toBe('"0"');
  });
});

describe('LadybugGraphStore traverse direction', () => {
  it("reports incoming edges with correct source/target under 'both'", async () => {
    const { store, s, connQuery } = makeStoreWithMockEngine();
    s.nodeTypeMap.set('n1', 'Function');

    // 'both' must issue the two directed patterns; the undirected form
    // carries no direction info, which flipped incoming edges.
    connQuery.mockImplementation((cypher: string) => {
      if (cypher.includes('-[r:RELATES]->')) {
        return Promise.resolve([
          {
            fromId: 'n1',
            id: 'callee',
            name: 'callee',
            rel_id: 'r-out',
            rel_type: 'CALLS',
            rel_properties: '',
          },
        ]);
      }
      if (cypher.includes('<-[r:RELATES]-')) {
        return Promise.resolve([
          {
            fromId: 'n1',
            id: 'caller',
            name: 'caller',
            rel_id: 'r-in',
            rel_type: 'CALLS',
            rel_properties: '',
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const results = await store.traverse('n1', 'both', 1);

    const byRelId = new Map(results.map((r) => [r.relationship.id, r]));
    // Outgoing: n1 calls callee.
    expect(byRelId.get('r-out')?.relationship.source_id).toBe('n1');
    expect(byRelId.get('r-out')?.relationship.target_id).toBe('callee');
    // Incoming: caller calls n1 — must NOT be flipped.
    expect(byRelId.get('r-in')?.relationship.source_id).toBe('caller');
    expect(byRelId.get('r-in')?.relationship.target_id).toBe('n1');
  });
});

describe('LadybugGraphStore clearGraph abort behavior', () => {
  it('aborts queued query()/exec() tasks when clearGraph fires', async () => {
    const { store, s, connQuery } = makeStoreWithMockEngine();

    // Hold the queue open so pending tasks can't run until we say so.
    let releaseGate: () => void = () => {};
    s.queue = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // Enqueue two tasks before clearGraph fires — they capture generation 0.
    const pendingQuery = s.query('MATCH (n) RETURN n');
    const pendingExec = s.exec('CREATE (n)');

    // clearGraph bumps the generation and enqueues its own DDL.
    const clearPromise = store.clearGraph();

    // Release the gate so the chain can drain.
    releaseGate();

    // Pre-clearGraph tasks should reject with AbortError.
    await expect(pendingQuery).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pendingExec).rejects.toMatchObject({ name: 'AbortError' });

    // clearGraph itself completes.
    await expect(clearPromise).resolves.toBeUndefined();

    // conn.query was called only for clearGraph's DDL, never for the
    // aborted user queries.
    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(cyphers).not.toContain('MATCH (n) RETURN n');
    expect(cyphers).not.toContain('CREATE (n)');
    // Sanity: clearGraph did dispatch some DROP/CREATE DDL.
    expect(cyphers.some((c: string) => c.startsWith('DROP TABLE'))).toBe(true);
  });

  it('allows queries enqueued after clearGraph to run normally', async () => {
    const { store, s, connQuery } = makeStoreWithMockEngine();

    // Fire clearGraph first (bumps gen 0 → 1, completes its DDL).
    await store.clearGraph();

    // Subsequent query captures gen 1, matches current gen 1, runs normally.
    const rows = await s.query('MATCH (n) RETURN n');
    expect(rows).toEqual([]);

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(cyphers).toContain('MATCH (n) RETURN n');
  });

  it('drops and recreates the NodeVector table', async () => {
    const { store, connQuery } = makeStoreWithMockEngine();

    await store.clearGraph();

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(cyphers).toContain('DROP TABLE IF EXISTS NodeVector');
    const recreateIdx = cyphers.findIndex((c: string) =>
      c.includes('CREATE NODE TABLE IF NOT EXISTS NodeVector'),
    );
    expect(recreateIdx).toBeGreaterThan(
      cyphers.indexOf('DROP TABLE IF EXISTS NodeVector'),
    );
  });

  it('bumps the generation counter on clearGraph', async () => {
    const { store, s } = makeStoreWithMockEngine();

    expect(s.generation).toBe(0);
    await store.clearGraph();
    expect(s.generation).toBe(1);
    await store.clearGraph();
    expect(s.generation).toBe(2);
  });
});

describe('LadybugGraphStore deleteRepo', () => {
  it('issues scoped Cypher deletes (rels first, then each repo-scoped table)', async () => {
    const { store, connQuery } = makeStoreWithMockEngine();

    await store.deleteRepo('alice/foo');

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    // Relationship delete must come before every node delete — Kuzu
    // rejects node drops while endpoint rels still reference them. A
    // single findIndex only proves the FIRST node-delete is ordered,
    // so walk the whole list.
    const relIdx = cyphers.findIndex((c: string) =>
      c.includes('-[r:RELATES]->'),
    );
    expect(relIdx).toBeGreaterThanOrEqual(0);
    const nodeDeletePattern =
      /^MATCH \(n:(Repository|Directory|File|Class|Function|Variable|PullRequest|IndexMetadata|SourceText)\).*DELETE n$/;
    const nodeDeleteIndexes = cyphers
      .map((c: string, i: number) => (nodeDeletePattern.test(c) ? i : -1))
      .filter((i: number) => i >= 0);
    expect(nodeDeleteIndexes.length).toBeGreaterThan(0);
    for (const idx of nodeDeleteIndexes) {
      expect(idx).toBeGreaterThan(relIdx);
    }

    // Every repo-scoped table is targeted.
    const tables = [
      'Repository',
      'Directory',
      'File',
      'Class',
      'Function',
      'Variable',
      'PullRequest',
      'IndexMetadata',
      'SourceText',
    ];
    for (const table of tables) {
      expect(
        cyphers.some(
          (c: string) =>
            c.includes(`MATCH (n:${table})`) && c.includes('DELETE n'),
        ),
      ).toBe(true);
    }

    // Repo-scoped match clause uses the correct id patterns. Only
    // applies to DELETE queries — the post-delete pass issues a global
    // `MATCH (n:Dependency) RETURN n.id` to rebuild the dedup set, and
    // that one intentionally has no repo predicate.
    for (const c of cyphers) {
      if (c.startsWith('MATCH (n:') && c.includes('DELETE n')) {
        expect(c).toContain("'alice/foo'");
        expect(c).toContain("'alice/foo/'");
        expect(c).toContain("'_meta:index:alice/foo'");
      }
    }

    // Dependency is the only global table; it must never be deleted.
    // (A read-only MATCH on Dependency is expected — that's the dedup-set
    // rebuild.)
    expect(
      cyphers.some(
        (c: string) =>
          c.includes('MATCH (n:Dependency)') && c.includes('DELETE n'),
      ),
    ).toBe(false);
  });

  it('prunes in-memory state keyed by the repo but spares other repos', async () => {
    const { store, s, connQuery } = makeStoreWithMockEngine();

    // The post-delete pass runs two Dependency reads in order: the
    // orphan-sweep query (distinguished by `count(r)`) which should see
    // no orphans here because lodash is still referenced by bob/bar, and
    // the dedup-set rebuild which returns surviving rows.
    connQuery.mockImplementation(async (cypher: string) => {
      if (!cypher.includes('(n:Dependency)')) return [];
      if (cypher.includes('count(r)')) return []; // orphan sweep
      if (cypher.includes('RETURN n.id')) return [{ id: 'pkg:npm:lodash' }];
      return [];
    });

    // Seed state that would exist after an index run of two repos plus a
    // shared package.
    const aRepo = 'alice/foo';
    const bRepo = 'bob/bar';
    const seedNode = (id: string, type: string) => {
      s.nodeTypeMap.set(id, type);
      s.nodeCache.set(id, { type, name: id, properties: {} });
      s.bm25Index.addDocument(id, `${id} ${type}`, { name: id });
    };
    const seedSource = (id: string) => {
      s.sourceCache.set(id, {
        compressed: new Uint8Array(),
        path: id.split('/').slice(2).join('/'),
      });
      s.sourceSnippets.set(id, `// source of ${id}`);
      s.flushedSourceIds.add(id);
    };

    // Repo A
    seedNode(aRepo, 'Repository');
    seedNode(`${aRepo}/src`, 'Directory');
    seedNode(`${aRepo}/src/app.ts`, 'File');
    seedNode(`${aRepo}/src/app.ts::App`, 'Class');
    seedNode(`_meta:index:${aRepo}`, 'IndexMetadata');
    seedSource(`${aRepo}/src/app.ts`);

    // Repo B (must survive)
    seedNode(bRepo, 'Repository');
    seedNode(`${bRepo}/lib/util.ts`, 'File');
    seedNode(`_meta:index:${bRepo}`, 'IndexMetadata');
    seedSource(`${bRepo}/lib/util.ts`);

    // Shared global Dependency (must survive, plus its flushedPackageIds guard)
    seedNode('pkg:npm:lodash', 'Dependency');
    s.flushedPackageIds.add('pkg:npm:lodash');

    // Pending buffers contain entries for both repos.
    s.pendingNodes = [
      { id: `${aRepo}/src/new.ts`, type: 'File', name: 'new.ts' },
      { id: `${bRepo}/lib/util.ts`, type: 'File', name: 'util.ts' },
    ];
    s.pendingRels = [
      {
        id: 'rel-a',
        type: 'DEFINES',
        source_id: aRepo,
        target_id: `${aRepo}/src/new.ts`,
      },
      {
        id: 'rel-b',
        type: 'DEFINES',
        source_id: bRepo,
        target_id: `${bRepo}/lib/util.ts`,
      },
    ];
    s.totalNodesBuffered = 2;
    s.totalRelsBuffered = 2;

    await store.deleteRepo(aRepo);

    // Repo A state gone
    for (const id of [
      aRepo,
      `${aRepo}/src`,
      `${aRepo}/src/app.ts`,
      `${aRepo}/src/app.ts::App`,
      `_meta:index:${aRepo}`,
    ]) {
      expect(s.nodeTypeMap.has(id)).toBe(false);
      expect(s.nodeCache.has(id)).toBe(false);
    }
    expect(s.sourceCache.has(`${aRepo}/src/app.ts`)).toBe(false);
    expect(s.sourceSnippets.has(`${aRepo}/src/app.ts`)).toBe(false);
    expect(s.flushedSourceIds.has(`${aRepo}/src/app.ts`)).toBe(false);

    // BM25 forgot repo A's docs but kept repo B's.
    expect(s.bm25Index.search('alice').length).toBe(0);
    expect(s.bm25Index.search('bob').length).toBeGreaterThan(0);

    // Repo B intact
    expect(s.nodeTypeMap.has(bRepo)).toBe(true);
    expect(s.nodeTypeMap.has(`${bRepo}/lib/util.ts`)).toBe(true);
    expect(s.nodeTypeMap.has(`_meta:index:${bRepo}`)).toBe(true);
    expect(s.sourceCache.has(`${bRepo}/lib/util.ts`)).toBe(true);

    // Shared Dependency and its guard untouched
    expect(s.nodeTypeMap.has('pkg:npm:lodash')).toBe(true);
    expect(s.flushedPackageIds.has('pkg:npm:lodash')).toBe(true);

    // Pending buffers filtered to only repo B's entries.
    expect(s.pendingNodes).toEqual([
      { id: `${bRepo}/lib/util.ts`, type: 'File', name: 'util.ts' },
    ]);
    expect(s.pendingRels).toEqual([
      {
        id: 'rel-b',
        type: 'DEFINES',
        source_id: bRepo,
        target_id: `${bRepo}/lib/util.ts`,
      },
    ]);
    expect(s.totalNodesBuffered).toBe(1);
    expect(s.totalRelsBuffered).toBe(1);
  });

  it('does not bump the generation counter', async () => {
    const { store, s } = makeStoreWithMockEngine();

    expect(s.generation).toBe(0);
    await store.deleteRepo('alice/foo');
    expect(s.generation).toBe(0);
  });

  it('is a no-op for an empty repoId', async () => {
    const { store, connQuery } = makeStoreWithMockEngine();

    await store.deleteRepo('');
    expect(connQuery).not.toHaveBeenCalled();
  });

  it('rebuilds flushedPackageIds from surviving Dependency rows', async () => {
    // The set guards COPY FROM against PK collisions on global Dependency
    // rows. deleteRepo leaves Dependencies intact (they're shared across
    // repos), but the in-memory set may be stale if we were populated from
    // one subset of repos and a later reindex needs to see the full
    // ground truth. The guard only works if the set matches the DB.
    const { store, s, connQuery } = makeStoreWithMockEngine();
    connQuery.mockImplementation(async (cypher: string) => {
      if (!cypher.includes('(n:Dependency)')) return [];
      // Orphan sweep (distinguished by `count(r)`): none here — the
      // focus of this test is the rebuild path, not the sweep.
      if (cypher.includes('count(r)')) return [];
      if (cypher.includes('RETURN n.id')) {
        return [
          { id: 'pkg:npm:lodash' },
          { id: 'pkg:npm:react' },
          { id: 'pkg:pypi:requests' },
        ];
      }
      return [];
    });

    // Seed a stale set that disagrees with the DB (missing one entry,
    // with an extra ghost entry left over from a deleted repo).
    s.flushedPackageIds.add('pkg:npm:lodash');
    s.flushedPackageIds.add('pkg:npm:ghost-from-deleted-repo');

    await store.deleteRepo('alice/foo');

    // Set matches what the mock returned: no ghost entries, all three
    // real rows present.
    expect([...s.flushedPackageIds].sort()).toEqual([
      'pkg:npm:lodash',
      'pkg:npm:react',
      'pkg:pypi:requests',
    ]);
  });

  it('sweeps Dependency nodes left orphaned by the deleted repo', async () => {
    // After deleteRepo's RELATES sweep removes this repo's DEPENDS_ON /
    // IMPORTS edges, any Dependency with zero remaining incoming edges
    // was exclusively owned by this repo (Dependencies are only ever
    // created paired with an edge) and is safe to delete. Shared
    // dependencies still have edges from other repos and must survive.
    const { store, connQuery } = makeStoreWithMockEngine();
    connQuery.mockImplementation(async (cypher: string) => {
      if (!cypher.includes('(n:Dependency)')) return [];
      // Orphan sweep: one package exclusively used by alice/foo.
      if (cypher.includes('count(r)')) {
        return [{ id: 'pkg:npm:only-used-by-alice' }];
      }
      // Dedup rebuild (runs after the sweep): the shared survivor.
      if (cypher.includes('RETURN n.id')) {
        return [{ id: 'pkg:npm:lodash' }];
      }
      return [];
    });

    await store.deleteRepo('alice/foo');

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);

    // The orphan-detection query ran.
    expect(
      cyphers.some(
        (c: string) =>
          c.includes('MATCH (n:Dependency)') && c.includes('count(r)'),
      ),
    ).toBe(true);

    // A Dependency DELETE was issued, targeting the orphan id.
    const depDelete = cyphers.find(
      (c: string) =>
        c.startsWith('MATCH (n:Dependency)') && c.includes('DELETE n'),
    );
    expect(depDelete).toBeDefined();
    expect(depDelete).toContain("'pkg:npm:only-used-by-alice'");
    // The survivor is not in the DELETE target list.
    expect(depDelete).not.toContain("'pkg:npm:lodash'");
    // The DELETE predicate is an id-list, not a repo-prefix clause.
    expect(depDelete).not.toContain("'alice/foo'");

    // Ordering: sweep must run before rebuildPackageDedupIndex. If the
    // rebuild ran first it would populate flushedPackageIds from rows
    // that the sweep then deletes, leaving stale ids in the guard — a
    // later re-index of the same repo would skip the COPY for those
    // packages and leave rels pointing at non-existent Dependencies.
    const orphanQueryIdx = cyphers.findIndex(
      (c: string) =>
        c.includes('MATCH (n:Dependency)') && c.includes('count(r)'),
    );
    const orphanDeleteIdx = cyphers.findIndex(
      (c: string) =>
        c.startsWith('MATCH (n:Dependency)') && c.includes('DELETE n'),
    );
    const rebuildIdx = cyphers.findIndex(
      (c: string) =>
        c.startsWith('MATCH (n:Dependency)') &&
        c.includes('RETURN n.id') &&
        !c.includes('count(r)'),
    );
    expect(orphanQueryIdx).toBeGreaterThanOrEqual(0);
    expect(orphanDeleteIdx).toBeGreaterThanOrEqual(0);
    expect(rebuildIdx).toBeGreaterThanOrEqual(0);
    expect(orphanQueryIdx).toBeLessThan(rebuildIdx);
    expect(orphanDeleteIdx).toBeLessThan(rebuildIdx);
  });

  it('skips the Dependency DELETE when no orphans exist', async () => {
    // When the orphan query returns zero rows, sweepOrphanedDependencies
    // returns early and never issues the DELETE. Guards against
    // accidentally running `DELETE n ... WHERE n.id IN []` which some
    // Cypher engines either reject or interpret unfavorably.
    const { store, connQuery } = makeStoreWithMockEngine();

    await store.deleteRepo('alice/foo');

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(
      cyphers.some(
        (c: string) =>
          c.startsWith('MATCH (n:Dependency)') && c.includes('DELETE n'),
      ),
    ).toBe(false);
  });
});

// Build a store whose mock conn routes each query() to caller-supplied rows
// based on the Cypher text (no real WASM — asserts query construction).
function makeStoreWithRows(
  route: (cypher: string) => Record<string, unknown>[],
) {
  // Mirror makeStoreWithMockEngine: the store reads rows via engine.query()
  // (which returns row objects directly — the engine shim owns the
  // getAllObjects/close lifecycle).
  const connQuery = vi
    .fn()
    .mockImplementation(async (cypher: string) => route(cypher));
  const engine = {
    init: vi.fn().mockResolvedValue(undefined),
    query: (cypher: string) => connQuery(cypher),
    exec: (cypher: string) => connQuery(cypher),
    fsWrite: vi.fn().mockResolvedValue(undefined),
    fsUnlink: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const store = new LadybugGraphStore(engine);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = store as any;
  s.ready = Promise.resolve();
  return { store, s, connQuery };
}

describe('LadybugGraphStore progressive loading', () => {
  it('fetchGraphSkeleton fetches only real skeleton types + edges among them', async () => {
    const { store, connQuery } = makeStoreWithRows((cypher) => {
      if (cypher.includes('MATCH (n:Repository)'))
        return [{ id: 'r1', type: 'Repository', name: 'repo' }];
      if (cypher.includes('MATCH (n:Directory)'))
        return [{ id: 'd1', type: 'Directory', name: 'dir' }];
      if (cypher.includes('MATCH (n:File)'))
        return [{ id: 'f1', type: 'File', name: 'file' }];
      if (cypher.includes('RELATES'))
        return [
          { source: 'r1', target: 'd1', type: 'CONTAINS', properties: null },
          { source: 'd1', target: 'f1', type: 'CONTAINS', properties: null },
          // endpoint not in the skeleton set → must be dropped by the JS filter
          { source: 'f1', target: 'fnX', type: 'DEFINES', properties: null },
        ];
      return [];
    });

    const data = await store.fetchGraphSkeleton([
      'Repository',
      'Directory',
      'File',
      'BogusType',
    ]);

    expect(data.nodes.map((n) => n.id).sort()).toEqual(['d1', 'f1', 'r1']);
    // The f1→fnX edge is dropped (fnX not loaded); the two CONTAINS survive.
    expect(data.links).toHaveLength(2);

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(cyphers.some((c) => c.includes('MATCH (n:Repository)'))).toBe(true);
    expect(cyphers.some((c) => c.includes('MATCH (n:File)'))).toBe(true);
    // The bogus (non-table) type is filtered out, never queried.
    expect(cyphers.some((c) => c.includes('MATCH (n:BogusType)'))).toBe(false);
    // Exactly one RELATES (edge) query.
    expect(cyphers.filter((c) => c.includes('RELATES')).length).toBe(1);
  });

  it('fetchGraphSkeleton returns empty for no real types', async () => {
    const { store, connQuery } = makeStoreWithRows(() => []);
    const data = await store.fetchGraphSkeleton(['Nope', 'AlsoNope']);
    expect(data).toEqual({ nodes: [], links: [] });
    expect(connQuery).not.toHaveBeenCalled();
  });

  it('fetchGraphPage uses SKIP/LIMIT and filters edges to the session set', async () => {
    const { store, s, connQuery } = makeStoreWithRows((cypher) => {
      if (cypher.includes('MATCH (n:Function)'))
        return [
          { id: 'fn1', type: 'Function', name: 'a' },
          { id: 'fn2', type: 'Function', name: 'b' },
        ];
      if (cypher.includes('RELATES'))
        return [
          // source already loaded (in session set), target in page → kept
          { source: 'f1', target: 'fn1', type: 'DEFINES', properties: null },
          // both in page → kept
          { source: 'fn1', target: 'fn2', type: 'CALLS', properties: null },
          // target not yet loaded → dropped (surfaces on a later page)
          { source: 'fn2', target: 'future', type: 'CALLS', properties: null },
        ];
      return [];
    });
    // Seed the accumulated session set as a prior skeleton/page would have.
    s.progressiveIds = new Set<string>(['f1']);

    const res = await store.fetchGraphPage({
      type: 'Function',
      offset: 0,
      limit: 2,
    });

    expect(res.nodes.map((n) => n.id)).toEqual(['fn1', 'fn2']);
    expect(res.exhausted).toBe(false); // full page (2 === limit)
    expect(res.links).toHaveLength(2); // fn2→future dropped
    // Page ids were folded into the session set.
    expect(s.progressiveIds.has('fn1')).toBe(true);
    expect(s.progressiveIds.has('fn2')).toBe(true);

    const fnQuery = connQuery.mock.calls
      .map((c: [string]) => c[0])
      .find((c) => c.includes('MATCH (n:Function)'));
    expect(fnQuery).toContain('SKIP 0');
    expect(fnQuery).toContain('LIMIT 2');
  });

  it('fetchGraphPage reports exhausted on a short page', async () => {
    const { store } = makeStoreWithRows((cypher) =>
      cypher.includes('MATCH (n:Variable)')
        ? [{ id: 'v1', type: 'Variable', name: 'x' }]
        : [],
    );
    const res = await store.fetchGraphPage({
      type: 'Variable',
      offset: 100,
      limit: 50,
    });
    expect(res.nodes).toHaveLength(1);
    expect(res.exhausted).toBe(true); // 1 < 50
  });

  it('fetchGraphPage no-ops for an unknown node type', async () => {
    const { store, connQuery } = makeStoreWithRows(() => []);
    const res = await store.fetchGraphPage({
      type: 'Nope',
      offset: 0,
      limit: 10,
    });
    expect(res).toEqual({ nodes: [], links: [], exhausted: true });
    expect(connQuery).not.toHaveBeenCalled();
  });

  it('fetchGraphSkeleton resets the session set', async () => {
    const { store, s } = makeStoreWithRows((cypher) =>
      cypher.includes('MATCH (n:File)')
        ? [{ id: 'f1', type: 'File', name: 'file' }]
        : [],
    );
    s.progressiveIds = new Set<string>(['stale1', 'stale2']);
    await store.fetchGraphSkeleton(['File']);
    expect(s.progressiveIds.has('stale1')).toBe(false);
    expect(s.progressiveIds.has('f1')).toBe(true);
  });
});

describe('LadybugGraphStore listNodes filter push-down', () => {
  it('pushes STRING equality filters into the Cypher WHERE clause', async () => {
    // Regression: filters used to run in JS AFTER `LIMIT n`, so matching
    // rows past the first n unfiltered rows were never seen (e.g.
    // listNodes('Function', 50, {language:'go'}) returned [] on a mixed
    // repo). The DB must apply the predicate before the LIMIT.
    const { store, connQuery } = makeStoreWithRows((cypher) => {
      if (cypher.includes("lower(n.language) = 'go'")) {
        return [
          { id: 'fn-go', type: 'Function', name: 'main', language: 'go' },
        ];
      }
      if (cypher.includes('MATCH (n:Function)')) {
        // Unfiltered listing would only surface TS rows.
        return Array.from({ length: 50 }, (_, i) => ({
          id: `fn-ts-${i}`,
          type: 'Function',
          name: `f${i}`,
          language: 'typescript',
        }));
      }
      return [];
    });

    const results = await store.listNodes('Function', 50, { language: 'go' });

    expect(results.map((n) => n.id)).toEqual(['fn-go']);
    const fnQuery = connQuery.mock.calls
      .map((c: [string]) => c[0])
      .find((c: string) => c.includes('MATCH (n:Function)'));
    expect(fnQuery).toContain("WHERE lower(n.language) = 'go'");
    expect(fnQuery).toContain('LIMIT 50');
  });

  it('escapes pushed filter values', async () => {
    const { store, connQuery } = makeStoreWithRows(() => []);
    await store.listNodes('Function', 10, { language: "o'caml" });
    const fnQuery = connQuery.mock.calls
      .map((c: [string]) => c[0])
      .find((c: string) => c.includes('MATCH (n:Function)'));
    expect(fnQuery).toContain("lower(n.language) = 'o\\'caml'");
  });

  it('pages through the table for non-pushable filters until limit matches', async () => {
    // `exported` is a BOOL column on Variable — not pushable as a string
    // equality, so the store must scan with SKIP/LIMIT pages instead of
    // filtering a single LIMIT-truncated page.
    const PAGE = 1000;
    const makePage = (skip: number, count: number) =>
      Array.from({ length: count }, (_, i) => {
        const idx = skip + i;
        return {
          id: `v${String(idx).padStart(5, '0')}`,
          type: 'Variable',
          name: `v${idx}`,
          // Matches live deep in the table, beyond the requested limit.
          exported: idx === 500 || idx === 1300,
        };
      });
    const { store, connQuery } = makeStoreWithRows((cypher) => {
      const m = /SKIP (\d+) LIMIT (\d+)/.exec(cypher);
      if (!m || !cypher.includes('MATCH (n:Variable)')) return [];
      const skip = Number(m[1]);
      // Table has 1500 rows total.
      return makePage(skip, Math.min(PAGE, Math.max(0, 1500 - skip)));
    });

    const results = await store.listNodes('Variable', 2, { exported: 'true' });

    expect(results.map((n) => n.id)).toEqual(['v00500', 'v01300']);
    const pagedQueries = connQuery.mock.calls
      .map((c: [string]) => c[0])
      .filter((c: string) => c.includes('MATCH (n:Variable)'));
    // Needed two pages to find both matches; each with a stable order.
    expect(pagedQueries.length).toBe(2);
    expect(pagedQueries[0]).toContain('ORDER BY n.id SKIP 0');
    expect(pagedQueries[1]).toContain('ORDER BY n.id SKIP 1000');
  });

  it('returns [] for unknown node types without querying', async () => {
    const { store, connQuery } = makeStoreWithRows(() => []);
    expect(await store.listNodes('Bogus', 10, { language: 'go' })).toEqual([]);
    expect(connQuery).not.toHaveBeenCalled();
  });
});

describe('LadybugGraphStore fetchGraphPage ordering', () => {
  it('pages with a stable ORDER BY n.id', async () => {
    // Without ORDER BY, SKIP/LIMIT rides storage order — a concurrent
    // append can shift an unseen row backward into an already-consumed
    // offset range and drop it permanently.
    const { store, connQuery } = makeStoreWithRows((cypher) =>
      cypher.includes('MATCH (n:Function)')
        ? [{ id: 'fn1', type: 'Function', name: 'a' }]
        : [],
    );
    await store.fetchGraphPage({ type: 'Function', offset: 40, limit: 20 });
    const fnQuery = connQuery.mock.calls
      .map((c: [string]) => c[0])
      .find((c: string) => c.includes('MATCH (n:Function)'));
    expect(fnQuery).toContain('ORDER BY n.id SKIP 40 LIMIT 20');
  });
});

describe('LadybugGraphStore flush failure handling', () => {
  const importMixedBatch = async (store: LadybugGraphStore) => {
    await store.importBatch({
      nodes: [
        { id: 'r/f.ts', type: 'File', name: 'f.ts', properties: {} },
        { id: 'r/f.ts::fn', type: 'Function', name: 'fn', properties: {} },
      ],
      relationships: [
        {
          id: 'rel1',
          type: 'DEFINES',
          source_id: 'r/f.ts',
          target_id: 'r/f.ts::fn',
          properties: {},
        },
      ],
    });
  };

  it('re-queues unwritten nodes and all rels when a node COPY fails, then retries cleanly', async () => {
    const { store, s, connQuery } = makeStoreWithMockEngine();
    const engine = s.engine as {
      fsWrite: ReturnType<typeof vi.fn>;
      fsUnlink: ReturnType<typeof vi.fn>;
    };
    await importMixedBatch(store);

    let failFunctionCopy = true;
    connQuery.mockImplementation(async (cypher: string) => {
      if (failFunctionCopy && cypher.startsWith('COPY Function')) {
        throw new Error('engine COPY exploded');
      }
      return [];
    });

    await expect(store.flush()).rejects.toThrow('engine COPY exploded');

    // The unwritten Function node and the relationship are back on the
    // pending buffers; the already-written File node is not.
    expect(s.pendingNodes.map((n: { id: string }) => n.id)).toEqual([
      'r/f.ts::fn',
    ]);
    expect(s.pendingRels.map((r: { id: string }) => r.id)).toEqual(['rel1']);
    // Temp CSVs never leak — every fsWrite has a matching fsUnlink, even
    // for the chunk whose COPY threw.
    expect(engine.fsUnlink.mock.calls.length).toBe(
      engine.fsWrite.mock.calls.length,
    );

    // A later flush retries the re-queued remainder successfully.
    failFunctionCopy = false;
    await store.flush();
    expect(s.pendingNodes).toEqual([]);
    expect(s.pendingRels).toEqual([]);
    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(
      cyphers.filter((c: string) => c.startsWith('COPY Function')).length,
    ).toBe(2);
    expect(
      cyphers.some((c: string) => c.startsWith('COPY RELATES_File_Function')),
    ).toBe(true);
  });

  it('re-queued Dependency nodes are made re-eligible for COPY', async () => {
    const { store, s, connQuery } = makeStoreWithMockEngine();
    await store.importBatch({
      nodes: [
        {
          id: 'pkg:npm:lodash',
          type: 'Dependency',
          name: 'lodash',
          properties: {},
        },
      ],
      relationships: [],
    });
    connQuery.mockImplementation(async (cypher: string) => {
      if (cypher.startsWith('COPY Dependency')) {
        throw new Error('boom');
      }
      return [];
    });

    await expect(store.flush()).rejects.toThrow('boom');

    // Without this, the eager flushedPackageIds.add would make the retry
    // skip the package forever.
    expect(s.flushedPackageIds.has('pkg:npm:lodash')).toBe(false);
    expect(s.pendingNodes.map((n: { id: string }) => n.id)).toEqual([
      'pkg:npm:lodash',
    ]);
  });

  it('a SourceText COPY failure does not drop the relationship flush', async () => {
    const { store, s, connQuery } = makeStoreWithMockEngine();
    await importMixedBatch(store);
    store.storeSource([{ id: 'r/f.ts', path: 'f.ts', content: 'const x = 1' }]);

    connQuery.mockImplementation(async (cypher: string) => {
      if (cypher.startsWith('COPY SourceText')) {
        throw new Error('source copy failed');
      }
      return [];
    });

    // Flush resolves; source text is deferred, not fatal.
    await store.flush();

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    expect(
      cyphers.some((c: string) => c.startsWith('COPY RELATES_File_Function')),
    ).toBe(true);
    // The failed snippet is NOT marked flushed — it retries next flush.
    expect(s.flushedSourceIds.has('r/f.ts')).toBe(false);
  });

  it('aborts the remaining chunks when clearGraph fires mid-flush', async () => {
    // Regression: flushInner used to let each chunk's exec() re-capture the
    // CURRENT generation, so a clearGraph between chunks recreated the
    // schema and the flush kept COPYing old-repo rows into it.
    const { store, s, connQuery } = makeStoreWithMockEngine();
    await importMixedBatch(store);

    let clearPromise: Promise<void> | null = null;
    connQuery.mockImplementation(async (cypher: string) => {
      if (cypher.startsWith('COPY File') && !clearPromise) {
        // Concurrent clearGraph lands while the File chunk is COPYing.
        clearPromise = store.clearGraph();
      }
      return [];
    });

    await expect(store.flush()).rejects.toMatchObject({ name: 'AbortError' });
    await clearPromise;

    const cyphers = connQuery.mock.calls.map((c: [string]) => c[0]);
    // The Function chunk (and rels) must never be COPY'd into the
    // freshly-recreated schema.
    expect(cyphers.some((c: string) => c.startsWith('COPY Function'))).toBe(
      false,
    );
    expect(cyphers.some((c: string) => c.startsWith('COPY RELATES'))).toBe(
      false,
    );
    // And nothing gets re-queued — clearGraph means "discard the batch".
    expect(s.pendingNodes).toEqual([]);
    expect(s.pendingRels).toEqual([]);
  });
});

describe('LadybugGraphStore ensureReady retry', () => {
  it('retries WASM init after a failed attempt instead of caching the rejection', async () => {
    const init = vi
      .fn()
      .mockRejectedValueOnce(new Error('wasm fetch failed'))
      .mockResolvedValue(undefined);
    const engine = {
      init,
      query: vi.fn().mockResolvedValue([]),
      exec: vi.fn().mockResolvedValue(undefined),
      fsWrite: vi.fn().mockResolvedValue(undefined),
      fsUnlink: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const store = new LadybugGraphStore(engine);

    // First caller sees the original error…
    await expect(store.ensureReady()).rejects.toThrow('wasm fetch failed');
    // …but the failure is not cached: the next call re-runs init and succeeds.
    await expect(store.ensureReady()).resolves.toBeUndefined();
    expect(init).toHaveBeenCalledTimes(2);
    // And once ready, further calls don't re-init.
    await store.ensureReady();
    expect(init).toHaveBeenCalledTimes(2);
  });
});
