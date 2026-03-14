import type { PipelineEvent, Store } from '../types';

/**
 * Wraps an inner event generator, saving graph data to the store
 * as graph_ready events flow through. All events are re-yielded unchanged.
 */
export function* execute(
  inner: Generator<PipelineEvent>,
  store: Store,
): Generator<PipelineEvent> {
  let nodesSaved = 0;
  let relsSaved = 0;

  for (const event of inner) {
    if (event.nodes) {
      for (const node of event.nodes) {
        store.saveNode(node);
      }
      nodesSaved += event.nodes.length;
    }
    if (event.relationships) {
      for (const rel of event.relationships) {
        store.saveRelationship(rel);
      }
      relsSaved += event.relationships.length;
    }
    yield event;
  }

  yield {
    kind: 'stage_stop',
    phase: 'submitting',
    message: `Saved ${nodesSaved} nodes and ${relsSaved} relationships`,
  };
}
