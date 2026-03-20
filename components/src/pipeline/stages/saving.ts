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
