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

import type { GraphNode } from '../types';
import type {
  ConcurrentPipelineEvent,
  ConcurrentPipelineOptions,
  StageMutation,
} from './types';

/**
 * Push all items from `src` into `dst` without spreading.
 * `Array.push(...src)` puts every element on the call stack as a
 * function argument — for large arrays this exceeds the stack limit.
 */
function pushAll<T>(dst: T[], src: readonly T[]): void {
  for (let j = 0; j < src.length; j++) {
    dst.push(src[j]);
  }
}

/**
 * Tick-based concurrent pipeline scheduler.
 *
 * Nodes flow through stages: output of stage N feeds into stage N+1.
 * Stages are processed in reverse order each tick so that nodes closer
 * to completion get priority (drain-first scheduling).
 *
 * Yields one {@link ConcurrentPipelineEvent} per action, enabling the
 * caller to drive the pipeline at their own pace.
 */
export function* runNodePipeline(
  opts: ConcurrentPipelineOptions,
): Generator<ConcurrentPipelineEvent> {
  const { ctx, stages, seeds } = opts;
  const stageCount = stages.length;

  // Per-stage queues: index 0 = first stage, etc.
  const queues: GraphNode[][] = Array.from({ length: stageCount }, () => []);
  pushAll(queues[0], seeds);

  // Counters for the final done event (no accumulation — avoids OOM on large repos)
  let totalNodes = seeds.length;
  let totalRelationships = 0;

  const hasWork = () => queues.some((q) => q.length > 0);

  // --- Main tick loop ---
  while (hasWork()) {
    if (ctx.cancelled) {
      yield { kind: 'pipeline_error', error: 'cancelled' };
      return;
    }

    let processed = false;

    // Reverse order: drain later stages first
    for (let i = stageCount - 1; i >= 0; i--) {
      if (queues[i].length === 0) continue;

      const node = queues[i].shift()!;
      const stage = stages[i];

      yield { stage: stage.name(), node: node.id, action: 'start' };

      let mutation: StageMutation;
      try {
        mutation = stage.process(node);
      } catch (err) {
        yield {
          kind: 'item_error',
          stage: stage.name(),
          node: node.id,
          error: err instanceof Error ? err.message : String(err),
        };
        processed = true;
        break;
      }

      yield { stage: stage.name(), node: node.id, action: 'end', mutation };

      totalRelationships += mutation.relationships.length;

      // Feed produced nodes into the next stage's queue
      if (mutation.nodes.length > 0) {
        totalNodes += mutation.nodes.length;
        if (i < stageCount - 1) {
          pushAll(queues[i + 1], mutation.nodes);
        }
      }

      processed = true;
      break; // one item per tick for interleaving
    }

    // Safety: if nothing was processed despite hasWork(), break to avoid infinite loop
    if (!processed) break;
  }

  // --- Flush phase ---
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
      mutation: mutation.nodes.length > 0 || mutation.relationships.length > 0
        ? mutation
        : undefined,
    };
  }

  yield {
    kind: 'pipeline_done',
    totalNodes,
    totalRelationships,
  };
}
