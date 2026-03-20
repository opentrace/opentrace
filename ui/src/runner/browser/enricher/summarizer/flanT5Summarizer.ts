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
 * Flan-T5 summarizer using Transformers.js (ONNX, runs in browser Web Worker).
 *
 * Dynamically imports @huggingface/transformers to avoid bundling it when
 * summarization is disabled.
 *
 * Performance optimizations:
 * - Quantized (q8) inference — 2-4× faster than fp32, minimal quality loss
 * - WebGPU acceleration when available — 5-10× faster than WASM
 * - Reduced max_new_tokens (32 vs 64) — halves decoder steps for one-sentence output
 */

import type {
  Summarizer,
  NodeKind,
  SummarizerConfig,
} from '@opentrace/components/pipeline';

const PROMPT_TEMPLATES: Record<NodeKind, string> = {
  function: 'Summarize what this function does in one sentence:\n\n',
  class: 'Summarize what this class does in one sentence:\n\n',
  file: 'Summarize what this source file does in one sentence:\n\n',
  directory:
    'Describe the purpose of this directory in one sentence based on its contents:\n\n',
};

export class FlanT5Summarizer implements Summarizer {
  private pipeline:
    | ((
        text: string | string[],
        options?: Record<string, unknown>,
      ) => Promise<
        | Array<{ generated_text: string }>
        | Array<Array<{ generated_text: string }>>
      >)
    | null = null;
  private config: SummarizerConfig;

  constructor(config: SummarizerConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    console.log('[FlanT5] importing @huggingface/transformers...');
    const transformers = await import('@huggingface/transformers');
    console.log('[FlanT5] import complete');

    // Disable local model check — always fetch from HuggingFace Hub
    if ('env' in transformers) {
      (transformers.env as Record<string, unknown>).allowLocalModels = false;
    }

    // Use WASM by default — avoids "No available adapters" browser warning
    // from WebGPU auto-detection when no GPU is present.
    console.log(
      `[FlanT5] creating pipeline: model=${this.config.model}, device=wasm, dtype=q8`,
    );
    const t0 = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import type is too narrow after `"env" in` guard
    this.pipeline = (await (transformers as any).pipeline(
      'text2text-generation',
      this.config.model,
      { dtype: 'q8', device: 'wasm' },
    )) as (
      text: string | string[],
      options?: Record<string, unknown>,
    ) => Promise<
      | Array<{ generated_text: string }>
      | Array<Array<{ generated_text: string }>>
    >;
    console.log(
      `[FlanT5] pipeline ready (${((performance.now() - t0) / 1000).toFixed(1)}s)`,
    );
  }

  private buildPrompt(source: string, kind: NodeKind): string {
    const maxChars = this.config.maxInputLength * 4;
    const truncated =
      source.length > maxChars ? source.slice(0, maxChars) : source;
    return PROMPT_TEMPLATES[kind] + truncated;
  }

  async summarize(source: string, kind: NodeKind): Promise<string> {
    if (!this.pipeline) {
      throw new Error('Summarizer not initialized — call init() first');
    }

    const prompt = this.buildPrompt(source, kind);
    console.log(`[FlanT5] summarize(${kind}, ${source.length} chars)...`);
    const t0 = performance.now();
    const result = await this.pipeline(prompt, { max_new_tokens: 32 });
    const text =
      (
        result as Array<{ generated_text: string }>
      )[0]?.generated_text?.trim() ?? '';
    console.log(
      `[FlanT5] summarize done (${((performance.now() - t0) / 1000).toFixed(1)}s): "${text.slice(0, 80)}"`,
    );
    return text;
  }

  async summarizeBatch(
    items: Array<{ source: string; kind: NodeKind }>,
  ): Promise<string[]> {
    if (!this.pipeline) {
      throw new Error('Summarizer not initialized — call init() first');
    }

    if (items.length === 0) return [];
    if (items.length === 1) {
      const s = await this.summarize(items[0].source, items[0].kind);
      return [s];
    }

    const prompts = items.map((item) =>
      this.buildPrompt(item.source, item.kind),
    );
    const result = await this.pipeline(prompts, { max_new_tokens: 32 });

    // When given an array, pipeline returns Array<Array<{generated_text}>>
    // Each outer element corresponds to one input prompt
    return (result as Array<Array<{ generated_text: string }>>).map(
      (r) =>
        (Array.isArray(r)
          ? r[0]?.generated_text?.trim()
          : (
              r as unknown as { generated_text: string }
            )?.generated_text?.trim()) ?? '',
    );
  }

  async dispose(): Promise<void> {
    this.pipeline = null;
  }
}
