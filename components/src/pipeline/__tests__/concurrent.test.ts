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
import { FileCacheStage } from '../concurrent/stages';
import { StoreStage } from '../concurrent/stages';
import { PipelineDebugLog } from '../concurrent/debug';
import type { GraphNode, PipelineContext } from '../types';

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
  return events.filter(
    (e): e is StageEvent => 'action' in e,
  );
}

function ctx(cancelled = false): PipelineContext {
  return { cancelled };
}

// --- Mock stages ---

/** Passes nodes through, optionally producing child nodes. */
class PassthroughStage implements INodeStage {
  _name: string;
  produceChildren: (n: GraphNode) => GraphNode[];

  constructor(name: string, produceChildren: (n: GraphNode) => GraphNode[] = () => []) {
    this._name = name;
    this.produceChildren = produceChildren;
  }
  name() { return this._name; }
  process(n: GraphNode): StageMutation {
    return { nodes: this.produceChildren(n), relationships: [] };
  }
  flush(): StageMutation { return { nodes: [], relationships: [] }; }
}

/** Only processes nodes of a given type; skips others by passing them through unchanged. */
class FilteredStage implements INodeStage {
  _name: string;
  acceptType: string;
  produceChildren: (n: GraphNode) => GraphNode[];

  constructor(name: string, acceptType: string, produceChildren: (n: GraphNode) => GraphNode[] = () => []) {
    this._name = name;
    this.acceptType = acceptType;
    this.produceChildren = produceChildren;
  }
  name() { return this._name; }
  process(n: GraphNode): StageMutation {
    if (n.type !== this.acceptType) {
      // Pass the node through without producing children
      return { nodes: [n], relationships: [] };
    }
    return { nodes: this.produceChildren(n), relationships: [] };
  }
  flush(): StageMutation { return { nodes: [], relationships: [] }; }
}

/** Accumulates nodes during process(), emits a batch on flush(). */
class AccumulatingStage implements INodeStage {
  _name: string;
  accumulated: GraphNode[] = [];

  constructor(name: string) {
    this._name = name;
  }
  name() { return this._name; }
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
  name() { return this._name; }
  process(n: GraphNode): StageMutation {
    if (n.id === this.errorOnId) {
      throw new Error(`explode on ${n.id}`);
    }
    return { nodes: [n], relationships: [] };
  }
  flush(): StageMutation { return { nodes: [], relationships: [] }; }
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
      expect(se[0]).toMatchObject({ stage: 'A', node: 'seed1', action: 'start' });
      expect(se[1]).toMatchObject({ stage: 'A', node: 'seed1', action: 'end' });
      expect(se[1].mutation?.nodes).toEqual([node('seed1-child', 'Class')]);

      // StageB processes seed1-child, produces seed1-child-grandchild
      expect(se[2]).toMatchObject({ stage: 'B', node: 'seed1-child', action: 'start' });
      expect(se[3]).toMatchObject({ stage: 'B', node: 'seed1-child', action: 'end' });
      expect(se[3].mutation?.nodes).toEqual([node('seed1-child-grandchild', 'Function')]);

      // pipeline_done reports total counts
      const done = events.find((e) => 'kind' in e && e.kind === 'pipeline_done');
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
        const startIdx = se.findIndex((e) => e.node === id && e.action === 'start');
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
      const downEvents = stageEvents(events).filter(
        (e) => e.stage === 'Down',
      );
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

  describe('EMPTY_MUTATION', () => {
    it('is frozen and reusable', () => {
      expect(EMPTY_MUTATION.nodes).toEqual([]);
      expect(EMPTY_MUTATION.relationships).toEqual([]);
      expect(Object.isFrozen(EMPTY_MUTATION)).toBe(true);
    });
  });

  describe('FileCacheStage', () => {
    it('caches file content up to byte limit', () => {
      const contentMap = new Map([
        ['repo/a.ts', 'const a = 1;'],
        ['repo/b.ts', 'const b = 2;'],
        ['repo/c.ts', 'const c = 3;'],
      ]);

      // Set a tiny limit so we hit it
      const cache = new FileCacheStage({
        fileContentMap: contentMap,
        byteLimit: 30, // ~15 chars * 2 bytes = 30 bytes for first file
      });

      const fileA = { id: 'repo/a.ts', type: 'File', name: 'a.ts', properties: { path: 'a.ts' } };
      const fileB = { id: 'repo/b.ts', type: 'File', name: 'b.ts', properties: { path: 'b.ts' } };
      const fileC = { id: 'repo/c.ts', type: 'File', name: 'c.ts', properties: { path: 'c.ts' } };

      // First file fits
      cache.process(fileA);
      expect(cache.getContent('repo/a.ts')).toBe('const a = 1;');
      expect(cache.isFull()).toBe(false);

      // Second file exceeds limit
      cache.process(fileB);
      expect(cache.getContent('repo/b.ts')).toBeUndefined();
      expect(cache.isFull()).toBe(true);

      // Third file also skipped
      cache.process(fileC);
      expect(cache.getContent('repo/c.ts')).toBeUndefined();

      const stats = cache.stats();
      expect(stats.cached).toBe(1);
      expect(stats.skipped).toBe(2);
    });

    it('passes non-File nodes through unchanged', () => {
      const cache = new FileCacheStage({ fileContentMap: new Map() });
      const dirNode = node('repo/src', 'Directory');
      const result = cache.process(dirNode);
      expect(result.nodes).toEqual([dirNode]);
    });

    it('passes File nodes through even when content not found', () => {
      const cache = new FileCacheStage({ fileContentMap: new Map() });
      const fileNode = { id: 'repo/x.ts', type: 'File', name: 'x.ts', properties: { path: 'x.ts' } };
      const result = cache.process(fileNode);
      expect(result.nodes).toEqual([fileNode]);
    });
  });

  describe('StoreStage', () => {
    it('accumulates nodes and is terminal', () => {
      const store = new StoreStage();

      const result1 = store.process(node('a'));
      const result2 = store.process(node('b'));

      // Terminal — no nodes forwarded
      expect(result1.nodes).toEqual([]);
      expect(result2.nodes).toEqual([]);

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

    it('works as terminal stage in pipeline', () => {
      const passthrough = new PassthroughStage('P', (n) => [n]);
      const store = new StoreStage();

      const events = collect({
        ctx: ctx(),
        stages: [passthrough, store],
        seeds: [node('x'), node('y')],
      });

      // Store is terminal — no nodes flow past it
      // But flush returns them
      const flushEnd = events.find(
        (e) => 'kind' in e && e.kind === 'flush_end' && e.stage === 'store',
      );
      expect(flushEnd).toBeDefined();
      if (flushEnd && 'kind' in flushEnd && flushEnd.kind === 'flush_end') {
        expect(flushEnd.mutation?.nodes).toHaveLength(2);
      }
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
      log.logEvent({ kind: 'pipeline_done', totalNodes: 0, totalRelationships: 0 });

      const entries = log.getEntries();
      // start + 3 events
      expect(entries.length).toBe(4);
      expect(entries[1].label).toBe('stage:extract');
      expect(entries[1].detail).toContain('start file1');
      expect(entries[2].detail).toContain('end file1');
      expect(entries[2].detail).toContain('nodes=1');
    });
  });
});
