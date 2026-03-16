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

import type {
  GraphNode,
  GraphRelationship,
  LoadingInput,
  PipelineContext,
  PipelineEvent,
  Store,
} from './types';
import { execute as scanning } from './stages/scanning';
import { execute as processing } from './stages/processing';
import { execute as resolving } from './stages/resolving';
import { execute as saving } from './stages/saving';

export { initParsers } from './stages/parsing';

function* corePipeline(
  input: LoadingInput,
  ctx: PipelineContext,
): Generator<PipelineEvent> {
  const scanResult = yield* scanning(input, ctx);

  if (ctx.cancelled) return;

  const processingOutput = yield* processing(scanResult, ctx);

  if (ctx.cancelled) return;

  const finalResult = yield* resolving(processingOutput);

  yield {
    kind: 'done',
    phase: 'resolving',
    message: 'Pipeline complete',
    result: finalResult,
  };
}

export function* runPipeline(
  input: LoadingInput,
  ctx: PipelineContext,
  store?: Store,
): Generator<PipelineEvent> {
  const inner = corePipeline(input, ctx);
  if (store) {
    yield* saving(inner, store);
  } else {
    yield* inner;
  }
}

/** Collect all events and return aggregated nodes/relationships (convenience for tests). */
export function collectPipeline(
  input: LoadingInput,
  ctx: PipelineContext,
  store?: Store,
): {
  events: PipelineEvent[];
  nodes: GraphNode[];
  relationships: GraphRelationship[];
} {
  const events: PipelineEvent[] = [];
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];

  for (const event of runPipeline(input, ctx, store)) {
    events.push(event);
    if (event.nodes) nodes.push(...event.nodes);
    if (event.relationships) relationships.push(...event.relationships);
  }

  return { events, nodes, relationships };
}
