/**
 * MiniLM embedder using @huggingface/transformers feature-extraction pipeline.
 *
 * Runs the Xenova/all-MiniLM-L6-v2 model (384-dim) entirely in the browser
 * via ONNX Runtime WASM. The model is dynamically imported to avoid loading
 * the ~30MB bundle when embedding is disabled.
 */

import type { EmbedderConfig, Embedder } from './types';

export class MiniLmEmbedder implements Embedder {
  private config: EmbedderConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipeline: any = null;
  private dim = 384;

  constructor(config: EmbedderConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    // Dynamic import to avoid bundling Transformers.js when not needed.
    const { pipeline } = await import('@huggingface/transformers');
    this.pipeline = await pipeline('feature-extraction', this.config.model, {
      // Use quantized model for smaller download and faster inference.
      dtype: 'q8',
      // Explicit WASM device avoids WebGPU auto-detection, which logs
      // "No available adapters" warnings when no GPU is present.
      device: 'wasm',
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipeline) {
      throw new Error('MiniLmEmbedder not initialized — call init() first');
    }

    const results: number[][] = [];
    // Process one at a time to avoid OOM in browser WASM environment.
    for (const text of texts) {
      const output = await this.pipeline(text, {
        pooling: 'mean',
        normalize: true,
      });
      // output.tolist() returns [[...dims]] for single input
      const embedding: number[] = output.tolist()[0];
      results.push(embedding);
    }

    return results;
  }

  dimension(): number {
    return this.dim;
  }

  async dispose(): Promise<void> {
    if (this.pipeline) {
      await this.pipeline.dispose();
      this.pipeline = null;
    }
  }
}
