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
import { runNodePipeline } from '../concurrent/scheduler';
import type {
  INodeStage,
  StageMutation,
  ConcurrentPipelineEvent,
  StageEvent,
} from '../concurrent/types';
import { EMPTY_MUTATION } from '../concurrent/types';
import { FileCacheStage, ResolveStage } from '../concurrent/stages';
import { StoreStage } from '../concurrent/stages';
import { PipelineDebugLog } from '../concurrent/debug';
import type { GraphNode, PipelineContext } from '../types';
import type { CallInfo, Registries, SymbolNode } from '../parser/callResolver';

// --- Helpers ---

function node(id: string, type = 'File'): GraphNode {
  return { id, type, name: id };
}

function collect(
  opts: Parameters<typeof runNodePipeline>[0],
): ConcurrentPipelineEvent[] {
  return [...runNodePipeline(opts)];
}

function stageEvents(events: ConcurrentPipelineEvent[]): StageEvent[] {
  return events.filter((e): e is StageEvent => 'action' in e);
}

function ctx(cancelled = false): PipelineContext {
  return { cancelled };
}

// --- Mock stages ---

/** Passes nodes through, optionally producing child nodes. */
class PassthroughStage implements INodeStage {
  _name: string;
  produceChildren: (n: GraphNode) => GraphNode[];

  constructor(
    name: string,
    produceChildren: (n: GraphNode) => GraphNode[] = () => [],
  ) {
    this._name = name;
    this.produceChildren = produceChildren;
  }
  name() {
    return this._name;
  }
  process(n: GraphNode): StageMutation {
    return { nodes: this.produceChildren(n), relationships: [] };
  }
  flush(): StageMutation {
    return { nodes: [], relationships: [] };
  }
}

/** Only processes nodes of a given type; skips others by passing them through unchanged. */
class FilteredStage implements INodeStage {
  _name: string;
  acceptType: string;
  produceChildren: (n: GraphNode) => GraphNode[];

  constructor(
    name: string,
    acceptType: string,
    produceChildren: (n: GraphNode) => GraphNode[] = () => [],
  ) {
    this._name = name;
    this.acceptType = acceptType;
    this.produceChildren = produceChildren;
  }
  name() {
    return this._name;
  }
  process(n: GraphNode): StageMutation {
    if (n.type !== this.acceptType) {
      // Pass the node through without producing children
      return { nodes: [n], relationships: [] };
    }
    return { nodes: this.produceChildren(n), relationships: [] };
  }
  flush(): StageMutation {
    return { nodes: [], relationships: [] };
  }
}

/** Accumulates nodes during process(), emits a batch on flush(). */
class AccumulatingStage implements INodeStage {
  _name: string;
  accumulated: GraphNode[] = [];

  constructor(name: string) {
    this._name = name;
  }
  name() {
    return this._name;
  }
  process(n: GraphNode): StageMutation {
    this.accumulated.push(n);
    return { nodes: [], relationships: [] };
  }
  flush(): StageMutation {
    const batchNode = node(`${this._name}-batch`, 'Batch');
    batchNode.properties = { count: this.accumulated.length };
    return {
      nodes: [batchNode],
      relationships: [
        {
          id: `${this._name}-batch->SUMMARIZES->all`,
          type: 'SUMMARIZES',
          source_id: batchNode.id,
          target_id: this.accumulated[0]?.id ?? 'none',
        },
      ],
    };
  }
}

/** Throws on a specific node ID. */
class ErrorStage implements INodeStage {
  _name: string;
  errorOnId: string;

  constructor(name: string, errorOnId: string) {
    this._name = name;
    this.errorOnId = errorOnId;
  }
  name() {
    return this._name;
  }
  process(n: GraphNode): StageMutation {
    if (n.id === this.errorOnId) {
      throw new Error(`explode on ${n.id}`);
    }
    return { nodes: [n], relationships: [] };
  }
  flush(): StageMutation {
    return { nodes: [], relationships: [] };
  }
}

// --- Tests ---

describe('concurrent pipeline', () => {
  describe('node flow', () => {
    it('output of stage N feeds into stage N+1', () => {
      const stageA = new PassthroughStage('A', (n) => [
        node(`${n.id}-child`, 'Class'),
      ]);
      const stageB = new PassthroughStage('B', (n) => [
        node(`${n.id}-grandchild`, 'Function'),
      ]);

      const events = collect({
        ctx: ctx(),
        stages: [stageA, stageB],
        seeds: [node('seed1')],
      });

      const se = stageEvents(events);

      // StageA processes seed1, produces seed1-child
      expect(se[0]).toMatchObject({
        stage: 'A',
        node: 'seed1',
        action: 'start',
      });
      expect(se[1]).toMatchObject({ stage: 'A', node: 'seed1', action: 'end' });
      expect(se[1].mutation?.nodes).toEqual([node('seed1-child', 'Class')]);

      // StageB processes seed1-child, produces seed1-child-grandchild
      expect(se[2]).toMatchObject({
        stage: 'B',
        node: 'seed1-child',
        action: 'start',
      });
      expect(se[3]).toMatchObject({
        stage: 'B',
        node: 'seed1-child',
        action: 'end',
      });
      expect(se[3].mutation?.nodes).toEqual([
        node('seed1-child-grandchild', 'Function'),
      ]);

      // pipeline_done reports total counts
      const done = events.find(
        (e) => 'kind' in e && e.kind === 'pipeline_done',
      );
      expect(done).toBeDefined();
      if (done && 'kind' in done && done.kind === 'pipeline_done') {
        // seed1 + seed1-child + seed1-child-grandchild = 3
        expect(done.totalNodes).toBe(3);
      }
    });
  });

  describe('event ordering', () => {
    it('start always before end for each node per stage', () => {
      const stage = new PassthroughStage('S', () => []);
      const events = collect({
        ctx: ctx(),
        stages: [stage],
        seeds: [node('a'), node('b'), node('c')],
      });
      const se = stageEvents(events);

      for (const id of ['a', 'b', 'c']) {
        const startIdx = se.findIndex(
          (e) => e.node === id && e.action === 'start',
        );
        const endIdx = se.findIndex((e) => e.node === id && e.action === 'end');
        expect(startIdx).toBeGreaterThanOrEqual(0);
        expect(endIdx).toBeGreaterThan(startIdx);
      }
    });

    it('parent end before child start across stages', () => {
      const stageA = new PassthroughStage('A', (n) => [node(`${n.id}-out`)]);
      const stageB = new PassthroughStage('B', () => []);

      const events = collect({
        ctx: ctx(),
        stages: [stageA, stageB],
        seeds: [node('x')],
      });
      const se = stageEvents(events);

      const parentEnd = se.findIndex(
        (e) => e.stage === 'A' && e.node === 'x' && e.action === 'end',
      );
      const childStart = se.findIndex(
        (e) => e.stage === 'B' && e.node === 'x-out' && e.action === 'start',
      );
      expect(parentEnd).toBeGreaterThanOrEqual(0);
      expect(childStart).toBeGreaterThan(parentEnd);
    });
  });

  describe('interleaving', () => {
    it('interleaves stages when processing multiple seeds', () => {
      const stageA = new PassthroughStage('S1', (n) => [node(`${n.id}-out`)]);
      const stageB = new PassthroughStage('S2', () => []);

      const events = collect({
        ctx: ctx(),
        stages: [stageA, stageB],
        seeds: [node('s1'), node('s2'), node('s3')],
      });
      const se = stageEvents(events);

      // After S1 processes s1, S2 should pick up s1-out before S1 finishes all seeds.
      // Because of reverse-order scheduling, S2 gets priority when its queue has items.
      const s1EndForSeed1 = se.findIndex(
        (e) => e.stage === 'S1' && e.node === 's1' && e.action === 'end',
      );
      const s2StartForSeed1Out = se.findIndex(
        (e) => e.stage === 'S2' && e.node === 's1-out' && e.action === 'start',
      );
      const s1StartForSeed3 = se.findIndex(
        (e) => e.stage === 'S1' && e.node === 's3' && e.action === 'start',
      );

      // S2 picks up s1-out before S1 processes s3
      expect(s2StartForSeed1Out).toBeGreaterThan(s1EndForSeed1);
      expect(s2StartForSeed1Out).toBeLessThan(s1StartForSeed3);
    });
  });

  describe('stage filtering', () => {
    it('nodes skip stages that do not accept their type', () => {
      // FilteredStage only processes 'File' nodes; passes others through
      const fileOnly = new FilteredStage('FileStage', 'File', (n) => [
        node(`${n.id}-extracted`, 'Class'),
      ]);
      const allTypes = new PassthroughStage('AllStage', () => []);

      const events = collect({
        ctx: ctx(),
        stages: [fileOnly, allTypes],
        seeds: [node('f1', 'File'), node('d1', 'Directory')],
      });
      const se = stageEvents(events);

      // FileStage processes both, but Directory just passes through
      const fileStageDir = se.filter(
        (e) => e.stage === 'FileStage' && e.node === 'd1',
      );
      expect(fileStageDir).toHaveLength(2); // start + end
      // Directory should still reach AllStage (passed through by FileStage)
      const allStageDir = se.filter(
        (e) => e.stage === 'AllStage' && e.node === 'd1',
      );
      expect(allStageDir).toHaveLength(2); // start + end

      // File produces a Class child that also reaches AllStage
      const allStageClass = se.filter(
        (e) => e.stage === 'AllStage' && e.node === 'f1-extracted',
      );
      expect(allStageClass).toHaveLength(2);
    });
  });

  describe('flush', () => {
    it('flush produces final mutations', () => {
      const accum = new AccumulatingStage('Accum');

      const events = collect({
        ctx: ctx(),
        stages: [accum],
        seeds: [node('a'), node('b'), node('c')],
      });

      const flushEnd = events.find(
        (e) => 'kind' in e && e.kind === 'flush_end' && e.stage === 'Accum',
      );
      expect(flushEnd).toBeDefined();
      if (flushEnd && 'kind' in flushEnd && flushEnd.kind === 'flush_end') {
        expect(flushEnd.mutation).toBeDefined();
        expect(flushEnd.mutation!.nodes).toHaveLength(1);
        expect(flushEnd.mutation!.nodes[0].id).toBe('Accum-batch');
        expect(flushEnd.mutation!.relationships).toHaveLength(1);
      }

      // pipeline_done should include flush counts
      const done = events.find(
        (e) => 'kind' in e && e.kind === 'pipeline_done',
      );
      expect(done).toBeDefined();
      if (done && 'kind' in done && done.kind === 'pipeline_done') {
        // 3 seeds (accumulated) + 1 flush batch node = 4
        expect(done.totalNodes).toBe(4);
        expect(done.totalRelationships).toBe(1);
      }
    });

    it('flush events appear for all stages', () => {
      const s1 = new PassthroughStage('S1');
      const s2 = new PassthroughStage('S2');

      const events = collect({
        ctx: ctx(),
        stages: [s1, s2],
        seeds: [node('x')],
      });

      const flushStarts = events.filter(
        (e) => 'kind' in e && e.kind === 'flush_start',
      );
      const flushEnds = events.filter(
        (e) => 'kind' in e && e.kind === 'flush_end',
      );
      expect(flushStarts).toHaveLength(2);
      expect(flushEnds).toHaveLength(2);
    });
  });

  describe('cancellation', () => {
    it('stops pipeline when context is cancelled', () => {
      const mutableCtx = { cancelled: false };
      let tickCount = 0;

      const stage = new PassthroughStage('S', () => {
        tickCount++;
        if (tickCount >= 2) mutableCtx.cancelled = true;
        return [];
      });

      const events = collect({
        ctx: mutableCtx,
        stages: [stage],
        seeds: [node('a'), node('b'), node('c'), node('d')],
      });

      const error = events.find(
        (e) => 'kind' in e && e.kind === 'pipeline_error',
      );
      expect(error).toBeDefined();
      if (error && 'kind' in error && error.kind === 'pipeline_error') {
        expect(error.error).toBe('cancelled');
      }

      // Should not have processed all 4 seeds
      const processed = stageEvents(events).filter((e) => e.action === 'end');
      expect(processed.length).toBeLessThan(4);

      // No pipeline_done when cancelled
      const done = events.find(
        (e) => 'kind' in e && e.kind === 'pipeline_done',
      );
      expect(done).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('error in stage skips node, continues pipeline', () => {
      const errorStage = new ErrorStage('Err', 'b');
      const downstream = new PassthroughStage('Down', () => []);

      const events = collect({
        ctx: ctx(),
        stages: [errorStage, downstream],
        seeds: [node('a'), node('b'), node('c')],
      });

      // item_error for node b
      const itemError = events.find(
        (e) => 'kind' in e && e.kind === 'item_error',
      );
      expect(itemError).toBeDefined();
      if (itemError && 'kind' in itemError && itemError.kind === 'item_error') {
        expect(itemError.node).toBe('b');
        expect(itemError.stage).toBe('Err');
        expect(itemError.error).toContain('explode on b');
      }

      // Nodes a and c should still flow to downstream
      const downEvents = stageEvents(events).filter((e) => e.stage === 'Down');
      const downNodes = downEvents
        .filter((e) => e.action === 'start')
        .map((e) => e.node);
      expect(downNodes).toContain('a');
      expect(downNodes).toContain('c');
      expect(downNodes).not.toContain('b');

      // Pipeline still completes
      const done = events.find(
        (e) => 'kind' in e && e.kind === 'pipeline_done',
      );
      expect(done).toBeDefined();
    });
  });

  describe('scheduler dequeue equivalence', () => {
    /**
     * Reference copy of the scheduler as it was BEFORE the index-pointer
     * dequeue change — verbatim shift()-based logic. The production
     * scheduler must emit a byte-identical event stream.
     */
    function* runNodePipelineShiftReference(
      opts: Parameters<typeof runNodePipeline>[0],
    ): Generator<ConcurrentPipelineEvent> {
      const { ctx, stages, seeds } = opts;
      const stageCount = stages.length;
      const queues: GraphNode[][] = Array.from(
        { length: stageCount },
        () => [],
      );
      for (const s of seeds) queues[0].push(s);
      let totalNodes = seeds.length;
      let totalRelationships = 0;
      const hasWork = () => queues.some((q) => q.length > 0);

      while (hasWork()) {
        if (ctx.cancelled) {
          yield { kind: 'pipeline_error', error: 'cancelled' };
          return;
        }
        let processed = false;
        for (let i = stageCount - 1; i >= 0; i--) {
          if (queues[i].length === 0) continue;
          const n = queues[i].shift()!;
          const stage = stages[i];
          yield { stage: stage.name(), node: n.id, action: 'start' };
          let mutation: StageMutation;
          try {
            mutation = stage.process(n);
          } catch (err) {
            yield {
              kind: 'item_error',
              stage: stage.name(),
              node: n.id,
              error: err instanceof Error ? err.message : String(err),
            };
            processed = true;
            break;
          }
          yield { stage: stage.name(), node: n.id, action: 'end', mutation };
          totalRelationships += mutation.relationships.length;
          if (mutation.nodes.length > 0) {
            totalNodes += mutation.nodes.length;
            if (i < stageCount - 1) {
              for (const m of mutation.nodes) queues[i + 1].push(m);
            }
          }
          processed = true;
          break;
        }
        if (!processed) break;
      }

      for (const stage of stages) {
        if (ctx.cancelled) {
          yield { kind: 'pipeline_error', error: 'cancelled' };
          return;
        }
        yield { kind: 'flush_start', stage: stage.name() };
        let mutation: StageMutation;
        try {
          mutation = stage.flush();
        } catch (err) {
          yield {
            kind: 'pipeline_error',
            error: `flush error in ${stage.name()}: ${err instanceof Error ? err.message : String(err)}`,
          };
          return;
        }
        totalNodes += mutation.nodes.length;
        totalRelationships += mutation.relationships.length;
        yield {
          kind: 'flush_end',
          stage: stage.name(),
          mutation:
            mutation.nodes.length > 0 || mutation.relationships.length > 0
              ? mutation
              : undefined,
        };
      }
      yield { kind: 'pipeline_done', totalNodes, totalRelationships };
    }

    /** Stage set exercising branching, errors, pass-through, and flush
     *  batches — enough churn that stage queues repeatedly drain empty
     *  (hitting the new reset/reuse path) and refill. */
    const makeStages = (): INodeStage[] => [
      new PassthroughStage('gen', (n) =>
        n.type === 'File'
          ? [node(`${n.id}::a`, 'Class'), node(`${n.id}::b`, 'Function')]
          : [],
      ),
      new ErrorStage('err', 'f3::a'),
      new AccumulatingStage('accum'),
    ];
    const makeSeeds = () =>
      Array.from({ length: 12 }, (_, i) =>
        node(`f${i}`, i % 3 === 2 ? 'Directory' : 'File'),
      );

    it('index-pointer dequeue emits the same event stream as shift()', () => {
      const expected = [
        ...runNodePipelineShiftReference({
          ctx: ctx(),
          stages: makeStages(),
          seeds: makeSeeds(),
        }),
      ];
      const actual = collect({
        ctx: ctx(),
        stages: makeStages(),
        seeds: makeSeeds(),
      });

      // Sanity: the fixture actually produced a rich stream.
      expect(expected.length).toBeGreaterThan(50);
      expect(expected.some((e) => 'kind' in e && e.kind === 'item_error')).toBe(
        true,
      );
      expect(actual).toEqual(expected);
    });

    it('matches shift() semantics under mid-run cancellation', () => {
      const run = (
        pipeline: typeof runNodePipeline,
      ): ConcurrentPipelineEvent[] => {
        const mutableCtx = { cancelled: false };
        let ticks = 0;
        const stages: INodeStage[] = [
          new PassthroughStage('S', (n) => {
            ticks++;
            if (ticks === 7) mutableCtx.cancelled = true;
            return n.type === 'File' ? [node(`${n.id}-out`, 'Class')] : [];
          }),
          new AccumulatingStage('accum'),
        ];
        return [...pipeline({ ctx: mutableCtx, stages, seeds: makeSeeds() })];
      };

      expect(run(runNodePipeline)).toEqual(run(runNodePipelineShiftReference));
    });
  });

  describe('ResolveStage sliced resolution', () => {
    const sym = (
      id: string,
      name: string,
      fileId: string,
      kind: 'class' | 'function' = 'function',
    ): SymbolNode => ({
      id,
      name,
      kind,
      fileId,
      parentId: fileId,
      language: 'python',
      receiverVar: null,
      receiverType: null,
      paramTypes: null,
      children: [],
    });

    /** Five callers in fileA: four resolve (intra-file bare + cross-file
     *  unique bare), one doesn't (unknown name). Spread across slice
     *  boundaries at sliceSize=2. */
    const makeFixture = (): {
      registries: Registries;
      allCallInfo: CallInfo[];
    } => {
      const helper = sym('fileA::helper', 'helper', 'fileA');
      const util = sym('fileB::util', 'util', 'fileB');
      const callers = Array.from({ length: 5 }, (_, i) =>
        sym(`fileA::caller${i}`, `caller${i}`, 'fileA'),
      );
      const registries: Registries = {
        nameRegistry: new Map([
          ['helper', [helper]],
          ['util', [util]],
        ]),
        fileRegistry: new Map([
          ['fileA', new Map([['helper', helper]])],
          ['fileB', new Map([['util', util]])],
        ]),
        classRegistry: new Map(),
        importRegistry: new Map(),
      };
      const allCallInfo: CallInfo[] = callers.map((caller, i) => ({
        callerNode: caller,
        fileId: 'fileA',
        calls: [
          i === 2
            ? { name: 'nonexistent', receiver: null, kind: 'bare' as const }
            : i % 2 === 0
              ? { name: 'helper', receiver: null, kind: 'bare' as const }
              : { name: 'util', receiver: null, kind: 'bare' as const },
        ],
      }));
      return { registries, allCallInfo };
    };

    // Hardcoded expectation, constructed by running the fixture through the
    // synchronous resolver as it existed before slicing was introduced:
    // callers 0/4 → intra-file helper (strategy 6, confidence 1.0),
    // callers 1/3 → unique cross-file util (strategy 7, confidence 0.8),
    // caller 2 → unresolved.
    const EXPECTED_RELS = [
      {
        id: 'fileA::caller0->CALLS->fileA::helper',
        type: 'CALLS',
        source_id: 'fileA::caller0',
        target_id: 'fileA::helper',
        properties: { confidence: 1.0 },
      },
      {
        id: 'fileA::caller1->CALLS->fileB::util',
        type: 'CALLS',
        source_id: 'fileA::caller1',
        target_id: 'fileB::util',
        properties: { confidence: 0.8 },
      },
      {
        id: 'fileA::caller3->CALLS->fileB::util',
        type: 'CALLS',
        source_id: 'fileA::caller3',
        target_id: 'fileB::util',
        properties: { confidence: 0.8 },
      },
      {
        id: 'fileA::caller4->CALLS->fileA::helper',
        type: 'CALLS',
        source_id: 'fileA::caller4',
        target_id: 'fileA::helper',
        properties: { confidence: 1.0 },
      },
    ];

    it('synchronous flush() matches the hardcoded pre-change expectation', () => {
      const stage = new ResolveStage(makeFixture());
      expect(stage.flush().relationships).toEqual(EXPECTED_RELS);
    });

    it('resolveSliced produces byte-identical output across slice boundaries', async () => {
      const sliced = new ResolveStage(makeFixture());
      await sliced.resolveSliced(undefined, 2); // slices of 2/2/1 CallInfos
      const slicedOut = sliced.flush();

      expect(slicedOut.relationships).toEqual(EXPECTED_RELS);
      expect(slicedOut.nodes).toEqual([]);
      // And identical to the unsliced path on the same fixture.
      expect(slicedOut).toEqual(new ResolveStage(makeFixture()).flush());
    });

    it('flush() consumes the precomputed result once, then falls back', async () => {
      const stage = new ResolveStage(makeFixture());
      await stage.resolveSliced(undefined, 2);
      expect(stage.flush().relationships).toEqual(EXPECTED_RELS);
      // Second flush re-resolves synchronously (fallback path).
      expect(stage.flush().relationships).toEqual(EXPECTED_RELS);
    });

    it('discards the partial result when cancelled between slices', async () => {
      const stage = new ResolveStage(makeFixture());
      let calls = 0;
      // Stop after the first slice has been resolved.
      await stage.resolveSliced(() => calls++ >= 1, 2);
      expect(stage.flush().relationships).toEqual([]);
    });
  });

  describe('EMPTY_MUTATION', () => {
    it('is frozen and reusable', () => {
      expect(EMPTY_MUTATION.nodes).toEqual([]);
      expect(EMPTY_MUTATION.relationships).toEqual([]);
      expect(Object.isFrozen(EMPTY_MUTATION)).toBe(true);
    });
  });

  describe('FileCacheStage', () => {
    it('caches file content eagerly up to byte limit', () => {
      const contentMap = new Map([
        ['repo/a.ts', 'const a = 1;'],
        ['repo/b.ts', 'const b = 2;'],
        ['repo/c.ts', 'const c = 3;'],
      ]);

      // Set a tiny limit so only the first file fits
      // 'const a = 1;' = 13 chars * 2 bytes = 26 bytes
      const cache = new FileCacheStage({
        fileContentMap: contentMap,
        byteLimit: 30,
      });

      // Caching happens eagerly in the constructor
      expect(cache.getContent('repo/a.ts')).toBe('const a = 1;');
      expect(cache.getContent('repo/b.ts')).toBeUndefined();
      expect(cache.getContent('repo/c.ts')).toBeUndefined();
      expect(cache.isFull()).toBe(true);

      const stats = cache.stats();
      expect(stats.cached).toBe(1);
      expect(stats.skipped).toBe(2);
    });

    it('process is passthrough', () => {
      const cache = new FileCacheStage({ fileContentMap: new Map() });
      const dirNode = node('repo/src', 'Directory');
      const result = cache.process(dirNode);
      expect(result.nodes).toEqual([dirNode]);
    });

    it('evict removes file from cache', () => {
      const contentMap = new Map([['repo/a.ts', 'const a = 1;']]);
      const cache = new FileCacheStage({ fileContentMap: contentMap });

      expect(cache.getContent('repo/a.ts')).toBe('const a = 1;');
      cache.evict('repo/a.ts');
      expect(cache.getContent('repo/a.ts')).toBeUndefined();
      expect(cache.getBytesUsed()).toBe(0);
    });
  });

  describe('StoreStage', () => {
    it('accumulates nodes and forwards them downstream', () => {
      const store = new StoreStage();

      const result1 = store.process(node('a'));
      const result2 = store.process(node('b'));

      // Forwards nodes so downstream stages (e.g. EmbedStage) can see them
      expect(result1.nodes).toEqual([node('a')]);
      expect(result2.nodes).toEqual([node('b')]);

      expect(store.stats()).toEqual({ nodes: 2, relationships: 0 });
    });

    it('accumulates relationships via addRelationships', () => {
      const store = new StoreStage();
      store.process(node('a'));

      store.addRelationships([
        { id: 'r1', type: 'CALLS', source_id: 'a', target_id: 'b' },
        { id: 'r2', type: 'IMPORTS', source_id: 'a', target_id: 'c' },
      ]);

      expect(store.stats()).toEqual({ nodes: 1, relationships: 2 });
    });

    it('flush returns all accumulated data', () => {
      const store = new StoreStage();
      store.process(node('a'));
      store.process(node('b'));
      store.addRelationships([
        { id: 'r1', type: 'CALLS', source_id: 'a', target_id: 'b' },
      ]);

      const mutation = store.flush();
      expect(mutation.nodes).toHaveLength(2);
      expect(mutation.relationships).toHaveLength(1);
      expect(mutation.nodes[0].id).toBe('a');
      expect(mutation.nodes[1].id).toBe('b');
    });

    it('works in pipeline and forwards nodes downstream', () => {
      const passthrough = new PassthroughStage('P', (n) => [n]);
      const store = new StoreStage();

      const events = collect({
        ctx: ctx(),
        stages: [passthrough, store],
        seeds: [node('x'), node('y')],
      });

      // Store processes nodes and forwards them
      const storeEnds = stageEvents(events).filter(
        (e) => e.stage === 'store' && e.action === 'end',
      );
      expect(storeEnds).toHaveLength(2);
      expect(storeEnds[0].mutation?.nodes).toHaveLength(1);
    });
  });

  describe('PipelineDebugLog', () => {
    it('captures entries with timing', () => {
      const log = new PipelineDebugLog();
      log.start();
      log.log('test', 'hello');
      log.log('test', 'world');

      const entries = log.getEntries();
      // start entry + 2 log entries
      expect(entries.length).toBe(3);
      expect(entries[1].label).toBe('test');
      expect(entries[1].detail).toBe('hello');
      expect(entries[1].elapsed).toBeGreaterThanOrEqual(0);
    });

    it('respects maxEntries ring buffer', () => {
      const log = new PipelineDebugLog({ maxEntries: 3 });
      log.start();
      log.log('a', '1');
      log.log('b', '2');
      log.log('c', '3'); // pushes out 'started'

      const entries = log.getEntries();
      expect(entries.length).toBe(3);
      expect(entries[0].detail).toBe('1');
    });

    it('does nothing when disabled', () => {
      const log = new PipelineDebugLog({ enabled: false });
      log.start();
      log.log('test', 'should not appear');
      expect(log.getEntries()).toHaveLength(0);
    });

    it('logs concurrent pipeline events', () => {
      const log = new PipelineDebugLog();
      log.start();

      log.logEvent({ stage: 'extract', node: 'file1', action: 'start' });
      log.logEvent({
        stage: 'extract',
        node: 'file1',
        action: 'end',
        mutation: { nodes: [node('cls1', 'Class')], relationships: [] },
      });
      log.logEvent({
        kind: 'pipeline_done',
        totalNodes: 0,
        totalRelationships: 0,
      });

      const entries = log.getEntries();
      // start + 3 events
      expect(entries.length).toBe(4);
      expect(entries[1].label).toBe('stage:extract');
      expect(entries[1].detail).toContain('start file1');
      expect(entries[2].detail).toContain('end file1');
      expect(entries[2].detail).toContain('nodes=1');
    });

    it('circular buffer wraps and keeps the most recent event entries', () => {
      const log = new PipelineDebugLog({ maxEntries: 3 });
      log.start(); // 'started'
      for (let i = 0; i < 5; i++) {
        log.logEvent({ stage: 'S', node: `n${i}`, action: 'start' });
      }
      const entries = log.getEntries();
      expect(entries.length).toBe(3);
      expect(entries.map((e) => e.detail)).toEqual([
        'start n2',
        'start n3',
        'start n4',
      ]);
    });

    it('summary() pairs start/end timings from lazily-stored events', () => {
      const log = new PipelineDebugLog();
      log.start();
      for (const n of ['a', 'b']) {
        log.logEvent({ stage: 'extract', node: n, action: 'start' });
        log.logEvent({
          stage: 'extract',
          node: n,
          action: 'end',
          mutation: { nodes: [], relationships: [] },
        });
      }
      // flush events must not pollute the start/end pairing.
      log.logEvent({ kind: 'flush_start', stage: 'extract' });
      log.logEvent({ kind: 'flush_end', stage: 'extract' });

      const s = log.summary();
      expect(s['stage:extract'].count).toBe(2);
      expect(s['stage:extract'].totalMs).toBeGreaterThanOrEqual(0);
    });

    it('mutation lengths are captured at log time, not retained by reference', () => {
      const log = new PipelineDebugLog();
      log.start();
      const mutation = { nodes: [node('x')], relationships: [] };
      log.logEvent({ stage: 'S', node: 'x', action: 'end', mutation });
      mutation.nodes.length = 0; // caller reuses/clears the array afterwards
      const entries = log.getEntries();
      expect(entries[1].detail).toBe('end x nodes=1 rels=0');
    });
  });
});
