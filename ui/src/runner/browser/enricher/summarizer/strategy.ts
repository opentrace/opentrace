/**
 * Hot-swappable summarization strategy — runtime-selectable via config.
 *
 * The pipeline receives a SummarizationStrategy instance and calls
 * strategy.summarize(meta) instead of importing static functions.
 * Strategies operate on SymbolMetadata (structured data), not raw source.
 */

import type {
  SummarizationStrategyType,
  SummarizerConfig,
  SymbolMetadata,
} from './types';
import { summarizeFromMetadata } from './templateSummarizer';

/** Race a promise against a timeout. Rejects with a descriptive error on timeout. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

export interface SummarizationStrategy {
  readonly type: SummarizationStrategyType;
  /** Load any required resources (model weights, etc.). No-op for template/noop. */
  init(): Promise<void>;
  /** Generate a one-sentence summary from structured metadata. */
  summarize(meta: SymbolMetadata): Promise<string>;
  /** Batch-summarize multiple items. Default impl calls summarize() in a loop. */
  summarizeBatch(items: SymbolMetadata[]): Promise<string[]>;
  /** Release resources. */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Template strategy — wraps the existing identifier-based summarizer
// ---------------------------------------------------------------------------

class TemplateStrategy implements SummarizationStrategy {
  readonly type = 'template' as const;

  async init(): Promise<void> {
    // Templates are instant — nothing to load
  }

  async summarize(meta: SymbolMetadata): Promise<string> {
    return summarizeFromMetadata(meta);
  }

  async summarizeBatch(items: SymbolMetadata[]): Promise<string[]> {
    return items.map(summarizeFromMetadata);
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// ML strategy — wraps FlanT5Summarizer under the new interface
// ---------------------------------------------------------------------------

const ML_INIT_TIMEOUT_MS = 120_000; // 2 min for model download + ONNX init
const ML_CALL_TIMEOUT_MS = 30_000; // 30s per inference call

class MlStrategy implements SummarizationStrategy {
  readonly type = 'ml' as const;
  private summarizer: import('./flanT5Summarizer').FlanT5Summarizer | null =
    null;
  private config: SummarizerConfig;

  constructor(config: SummarizerConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    console.log(
      `[MlStrategy] init: model=${this.config.model}, timeout=${ML_INIT_TIMEOUT_MS}ms`,
    );
    const { FlanT5Summarizer } = await import('./flanT5Summarizer');
    this.summarizer = new FlanT5Summarizer(this.config);
    await withTimeout(
      this.summarizer.init(),
      ML_INIT_TIMEOUT_MS,
      'ML summarizer init',
    );
    console.log('[MlStrategy] init complete');
  }

  async summarize(meta: SymbolMetadata): Promise<string> {
    if (!this.summarizer)
      throw new Error('MlStrategy not initialized — call init() first');
    const source = meta.source ?? meta.name;
    try {
      return await withTimeout(
        this.summarizer.summarize(source, meta.kind),
        ML_CALL_TIMEOUT_MS,
        `ML summarize(${meta.name})`,
      );
    } catch (err) {
      console.warn(`[MlStrategy] summarize failed for ${meta.name}:`, err);
      throw err;
    }
  }

  async summarizeBatch(items: SymbolMetadata[]): Promise<string[]> {
    if (!this.summarizer)
      throw new Error('MlStrategy not initialized — call init() first');
    return withTimeout(
      this.summarizer.summarizeBatch(
        items.map((m) => ({ source: m.source ?? m.name, kind: m.kind })),
      ),
      ML_CALL_TIMEOUT_MS * items.length,
      'ML summarizeBatch',
    );
  }

  async dispose(): Promise<void> {
    await this.summarizer?.dispose();
    this.summarizer = null;
  }
}

// ---------------------------------------------------------------------------
// LLM strategy — calls any OpenAI-compatible local server (e.g. Ollama)
// ---------------------------------------------------------------------------

const LLM_CALL_TIMEOUT_MS = 60_000;

class LlmStrategy implements SummarizationStrategy {
  readonly type = 'llm' as const;
  private url: string;
  private model: string;

  constructor(config: SummarizerConfig) {
    this.url =
      config.llmUrl ??
      `${window.location.protocol}//${window.location.hostname}:11434`;
    this.model = config.llmModel ?? 'llama3.2';
  }

  async init(): Promise<void> {}

  private buildPrompt(meta: SymbolMetadata): string {
    const source = meta.source ?? meta.name;
    switch (meta.kind) {
      case 'function':
        return `Summarize what this function does in one sentence:\n\n${source}`;
      case 'class':
        return `Summarize what this class does in one sentence:\n\n${source}`;
      case 'file':
        return `Summarize what this source file does in one sentence:\n\n${source}`;
      case 'directory':
        return `Describe the purpose of this directory in one sentence:\n\n${source}`;
    }
  }

  async summarize(meta: SymbolMetadata): Promise<string> {
    const prompt = this.buildPrompt(meta);
    const json = await withTimeout(
      fetch(`${this.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          stream: false,
        }),
      fetch(`${this.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 100,
          stream: false,
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      LLM_CALL_TIMEOUT_MS,
      `LLM summarize(${meta.name})`,
    );
    return (json.choices?.[0]?.message?.content ?? '').trim();
  }

  async summarizeBatch(items: SymbolMetadata[]): Promise<string[]> {
    return Promise.all(items.map((item) => this.summarize(item)));
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Noop strategy — returns empty strings (summarization disabled)
// ---------------------------------------------------------------------------

class NoopStrategy implements SummarizationStrategy {
  readonly type = 'none' as const;

  async init(): Promise<void> {}
  async summarize(): Promise<string> {
    return '';
  }
  async summarizeBatch(items: SymbolMetadata[]): Promise<string[]> {
    return items.map(() => '');
  }
  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create the appropriate summarization strategy from config. */
export function createStrategy(
  config: SummarizerConfig,
): SummarizationStrategy {
  if (!config.enabled || config.strategy === 'none') {
    return new NoopStrategy();
  }
  if (config.strategy === 'ml') {
    return new MlStrategy(config);
  }
  if (config.strategy === 'llm') {
    return new LlmStrategy(config);
  }
  return new TemplateStrategy();
}
