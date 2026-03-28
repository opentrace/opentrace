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

/**
 * Web Worker for embedding enrichment.
 *
 * Summaries are now pre-computed by the template summarizer in the parse pipeline,
 * so this worker only handles vector embedding. Processes EnrichItem batches
 * received from the manager, emitting graph updates as they're produced.
 */

import type { Embedder } from './embedder/types';
import type {
  EnrichItem,
  EnrichWorkerRequest,
  EnrichWorkerResponse,
  GraphNode,
  EmbedderWorkerConfig,
} from '../types';

let embedder: Embedder | undefined;
let cancelled = false;

/**
 * Build the text that gets embedded for a given enrichment item.
 * Includes metadata (name, type, path, summary) plus a capped
 * source snippet for file/function/class nodes so that semantic
 * search can match on actual code content.
 */
function composeSearchableText(item: EnrichItem, summary: string): string {
  const parts = [item.nodeName, item.nodeType];
  if (summary) parts.push(summary);
  if (item.path) parts.push(item.path);
  // Include source content (capped to stay within MiniLM 256-token context)
  if (item.source && item.kind !== 'directory') {
    const maxChars = item.kind === 'file' ? 300 : 500;
    parts.push(item.source.slice(0, maxChars));
  }
  return parts.join(' ');
}

const BATCH_SIZE = 8;

function post(msg: EnrichWorkerResponse) {
  self.postMessage(msg);
}

const EMBEDDER_INIT_TIMEOUT_MS = 60_000;

async function initEmbedder(config: EmbedderWorkerConfig) {
  if (!config.enabled) return;

  const { MiniLmEmbedder } = await import('./embedder/miniLmEmbedder');
  const instance = new MiniLmEmbedder(config);
  // Timeout prevents indefinite hang if model download stalls
  await Promise.race([
    instance.init(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              'Embedder init timed out (model download may be slow or unavailable)',
            ),
          ),
        EMBEDDER_INIT_TIMEOUT_MS,
      ),
    ),
  ]);
  embedder = instance;
}

async function handleEnrich(items: EnrichItem[]) {
  const totalItems = items.length;
  let enrichedCount = 0;

  post({
    type: 'progress',
    phase: 'embedding',
    message: 'Embedding nodes...',
    detail: { current: 0, total: totalItems },
  });

  for (
    let batchStart = 0;
    batchStart < items.length;
    batchStart += BATCH_SIZE
  ) {
    if (cancelled) return;

    const batch = items.slice(batchStart, batchStart + BATCH_SIZE);
    const updateNodes: GraphNode[] = [];

    for (let i = 0; i < batch.length; i++) {
      if (cancelled) return;

      const item = batch[i];
      const summary = item.summary || '';

      // Build update node — summary is already set by the pipeline, but include
      // it in the update in case this is the first time properties are merged.
      const updateNode: GraphNode = {
        id: item.nodeId,
        type: item.nodeType,
        name: item.nodeName,
        properties: summary ? { summary } : {},
      };

      // Embed non-directory nodes
      if (embedder && item.kind !== 'directory') {
        const searchText = composeSearchableText(item, summary);

        try {
          const embeddings = await embedder.embed([searchText]);
          if (embeddings.length > 0 && embeddings[0].length > 0) {
            updateNode.properties = {
              ...updateNode.properties,
              has_embedding: true,
            };
            updateNode.embedding = embeddings[0];
          }
        } catch {
          // Skip failed embeddings silently
        }
      }

      // Only emit if we actually produced an embedding
      if (updateNode.embedding) {
        updateNodes.push(updateNode);
      }
      enrichedCount++;
    }

    // Emit batch update
    if (updateNodes.length > 0) {
      post({ type: 'batch', nodes: updateNodes, relationships: [] });
    }

    post({
      type: 'progress',
      phase: 'embedding',
      message: 'Embedding nodes...',
      detail: {
        current: Math.min(batchStart + BATCH_SIZE, totalItems),
        total: totalItems,
      },
    });
  }

  post({
    type: 'stage-complete',
    phase: 'embedding',
    message: `Embedded ${enrichedCount} nodes`,
  });
  post({ type: 'done', enrichedCount });
}

self.onmessage = async (e: MessageEvent<EnrichWorkerRequest>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      try {
        if (msg.embedderConfig) {
          await initEmbedder(msg.embedderConfig).catch((err) => {
            post({
              type: 'progress',
              phase: 'initializing',
              message: `Embedder unavailable: ${err instanceof Error ? err.message : err}`,
              detail: { current: 0, total: 1 },
            });
          });
        }
        post({ type: 'ready' });
      } catch (err) {
        post({
          type: 'error',
          message: `Failed to init embedder: ${err instanceof Error ? err.message : err}`,
        });
      }
      break;

    case 'enrich':
      cancelled = false;
      handleEnrich(msg.items);
      break;

    case 'cancel':
      cancelled = true;
      break;
  }
};
