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
