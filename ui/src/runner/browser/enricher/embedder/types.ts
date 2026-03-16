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
