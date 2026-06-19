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
 * Web Worker that hosts the @huggingface/transformers MiniLM pipeline
 * (Fix #55 / Plan E). Moving the embedder off the main thread keeps
 * Pixi's ticker rendering at 60 fps during indexing — previously
 * each per-text inference (~50 ms WASM) blocked the main thread and
 * the rotation animation stuttered through the entire embed phase.
 *
 * Protocol: every request from the main thread carries a numeric
 * `seq`. The worker's reply echoes it so the proxy can match replies
 * to pending Promises. This is the same shape we'll want for the
 * LadybugDB worker (Plan D).
 */

import type { EmbedderConfig } from './types';

type InMessage =
  | { seq: number; type: 'init'; config: EmbedderConfig }
  | { seq: number; type: 'embed'; texts: string[] }
  | { seq: number; type: 'dispose' };

type OutMessage =
  | { seq: number; type: 'init-done'; dimension: number }
  | { seq: number; type: 'embed-result'; vectors: Float32Array[] }
  | { seq: number; type: 'dispose-done' }
  | { seq: number; type: 'error'; message: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelineInstance: any = null;
const dimension = 384;

// Serializes embed work across messages. `handleEmbed` is sequential
// *within* one message, but without this a second `embed` message could
// enter `onmessage` while the first is still awaiting, running concurrent
// WASM inference and defeating the OOM guard. Chain every embed onto this
// promise so only one runs at a time.
let embedQueue: Promise<void> = Promise.resolve();

async function handleInit(config: EmbedderConfig): Promise<number> {
  const { pipeline } = await import('@huggingface/transformers');
  pipelineInstance = await pipeline('feature-extraction', config.model, {
    // Quantized model — same defaults as the main-thread version.
    dtype: 'q8',
    device: 'wasm',
  });
  return dimension;
}

async function handleEmbed(texts: string[]): Promise<Float32Array[]> {
  if (!pipelineInstance) {
    throw new Error('embedder worker not initialized');
  }
  const out: Float32Array[] = [];
  // Sequential — same as the previous main-thread implementation,
  // which noted in its comments that batch inference can OOM in
  // browser WASM.
  for (const text of texts) {
    const output = await pipelineInstance(text, {
      pooling: 'mean',
      normalize: true,
    });
    // `output.data` is the underlying typed array; reuse it as a
    // transferable buffer to avoid copying through .tolist().
    // .data on Tensor is the typed array view onto the model's
    // output for this single text — slice() copies into a tight
    // buffer that we can transfer out.
    const data = output.data as Float32Array;
    out.push(new Float32Array(data));
  }
  return out;
}

async function handleDispose(): Promise<void> {
  if (pipelineInstance) {
    await pipelineInstance.dispose();
    pipelineInstance = null;
  }
}

self.onmessage = async (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      const dim = await handleInit(msg.config);
      const reply: OutMessage = {
        seq: msg.seq,
        type: 'init-done',
        dimension: dim,
      };
      (self as unknown as Worker).postMessage(reply);
      return;
    }
    if (msg.type === 'embed') {
      // Queue behind any in-flight embed so inference stays serialized.
      const task = embedQueue.then(async () => {
        const vectors = await handleEmbed(msg.texts);
        const reply: OutMessage = {
          seq: msg.seq,
          type: 'embed-result',
          vectors,
        };
        // Transfer the underlying buffers — zero-copy hand-off back to
        // the main thread. Once transferred we no longer hold a usable
        // reference in the worker, which is fine: we constructed them
        // for this reply and don't reuse.
        const transfer = vectors.map((v) => v.buffer);
        (self as unknown as Worker).postMessage(reply, transfer);
      });
      // Keep the chain alive even if this task rejects; the await below
      // routes the error to the catch handler for an error reply.
      embedQueue = task.catch(() => undefined);
      await task;
      return;
    }
    if (msg.type === 'dispose') {
      await handleDispose();
      const reply: OutMessage = { seq: msg.seq, type: 'dispose-done' };
      (self as unknown as Worker).postMessage(reply);
      return;
    }
  } catch (err) {
    const reply: OutMessage = {
      seq: msg.seq,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(reply);
  }
};
