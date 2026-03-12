/**
 * Embedder abstraction layer — shared interface for generating dense vector embeddings.
 *
 * Implementations can use different backends (Transformers.js, remote API, etc.)
 * while the pipeline code remains agnostic.
 */

export interface EmbedderConfig {
  enabled: boolean;
  model: string;
}

export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  enabled: true,
  model: 'Xenova/all-MiniLM-L6-v2',
};

export interface Embedder {
  /** Load the model into memory. Must be called before embed(). */
  init(): Promise<void>;

  /**
   * Generate embeddings for one or more text inputs.
   *
   * @param texts - Array of text strings to embed.
   * @returns Array of embedding vectors (number[]), one per input.
   */
  embed(texts: string[]): Promise<number[][]>;

  /** The dimensionality of the output embeddings. */
  dimension(): number;

  /** Release model resources. */
  dispose(): Promise<void>;
}
