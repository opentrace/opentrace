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

import type { GraphNode, GraphRelationship, PipelineContext } from '../types';

/** Mutation produced by a stage — new nodes and relationships to add to the graph. */
export interface StageMutation {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

/** Per-node per-stage event emitted by the scheduler. */
export interface StageEvent {
  stage: string;
  node: string;
  action: 'start' | 'end';
  mutation?: StageMutation;
}

/** Union of all events the concurrent pipeline can emit. */
export type ConcurrentPipelineEvent =
  | StageEvent
  | { kind: 'pipeline_done'; totalNodes: number; totalRelationships: number }
  | { kind: 'pipeline_error'; error: string }
  | { kind: 'item_error'; stage: string; node: string; error: string }
  | { kind: 'flush_start'; stage: string }
  | { kind: 'flush_end'; stage: string; mutation?: StageMutation };

/** A single stage in the concurrent pipeline. */
export interface INodeStage {
  /** Human-readable stage name (used in events). */
  name(): string;
  /** Process a single node. Return new nodes/relationships to add. */
  process(node: GraphNode): StageMutation;
  /** Finalize after all items have flowed through. */
  flush(): StageMutation;
}

/** Options for the concurrent pipeline scheduler. */
export interface ConcurrentPipelineOptions {
  ctx: PipelineContext;
  stages: INodeStage[];
  seeds: GraphNode[];
}

/** Empty mutation constant — avoids repeated allocations. */
export const EMPTY_MUTATION: Readonly<StageMutation> = Object.freeze({
  nodes: [],
  relationships: [],
});
