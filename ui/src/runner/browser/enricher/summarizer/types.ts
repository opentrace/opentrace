/**
 * Summarizer abstraction layer — shared interface for node summarization.
 *
 * Implementations can use different backends (Transformers.js, ONNX Runtime, etc.)
 * while the pipeline code remains agnostic.
 */

export type NodeKind = 'function' | 'class' | 'file' | 'directory';

export type SummarizationStrategyType = 'template' | 'ml' | 'llm' | 'none';

/** Structured metadata for template-based summarization (no source code needed). */
export interface SymbolMetadata {
  name: string;
  kind: NodeKind;
  signature?: string; // function params
  language?: string;
  lineCount?: number;
  childNames?: string[]; // method names (classes) or symbol names (files)
  fileName?: string; // file path context
  receiverType?: string; // Go methods
  source?: string; // code snippet for keyword extraction
  docs?: string; // extracted documentation comment (javadoc, pydoc, godoc, etc.)
}

export interface SummarizerConfig {
  enabled: boolean;
  /** Which summarization approach to use: template (instant), ml (FlanT5), llm (local), or none. */
  strategy: SummarizationStrategyType;
  model: string;
  /** Maximum input tokens for the model. Source is truncated to ~4× this in chars. */
  maxInputLength: number;
  /** Minimum lines for a function/class to be summarized via ML. Smaller ones get a template. */
  minLines: number;
  /** Base URL for the local LLM server (OpenAI-compatible). Used when strategy === 'llm'. */
  llmUrl?: string;
  /** Model name to use on the local LLM server. Used when strategy === 'llm'. */
  llmModel?: string;
}

export const DEFAULT_SUMMARIZER_CONFIG: SummarizerConfig = {
  enabled: true,
  strategy: 'template',
  model: 'Xenova/flan-t5-small',
  maxInputLength: 480,
  minLines: 5,
};

export interface Summarizer {
  /** Load the model into memory. Must be called before summarize(). */
  init(): Promise<void>;

  /**
   * Generate a one-sentence summary for a code snippet.
   *
   * @param source - The source code to summarize (will be truncated internally).
   * @param kind - What kind of code entity this is (function, class, file).
   * @returns The generated summary string.
   */
  summarize(source: string, kind: NodeKind): Promise<string>;

  /**
   * Summarize multiple items in a single batched forward pass.
   * Much faster than calling summarize() in a loop.
   *
   * @param items - Array of {source, kind} pairs to summarize.
   * @returns Array of summary strings (same order as input).
   */
  summarizeBatch(
    items: Array<{ source: string; kind: NodeKind }>,
  ): Promise<string[]>;

  /** Release model resources. */
  dispose(): Promise<void>;
}
