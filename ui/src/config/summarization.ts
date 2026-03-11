import type { SummarizerConfig, SummarizationStrategyType } from "../runner/browser/enricher/summarizer/types";
import { DEFAULT_SUMMARIZER_CONFIG } from "../runner/browser/enricher/summarizer/types";

const ENABLED_KEY = "ot_summarization_enabled";
const MODEL_KEY = "ot_summarization_model";
const STRATEGY_KEY = "ot_summarization_strategy";

export function loadSummarizerConfig(): SummarizerConfig {
  const stored = localStorage.getItem(ENABLED_KEY);
  const enabled = stored === null ? true : stored === "true";
  const model =
    localStorage.getItem(MODEL_KEY) || DEFAULT_SUMMARIZER_CONFIG.model;
  const strategy = loadSummarizerStrategy();
  return {
    enabled,
    strategy,
    model,
    maxInputLength: DEFAULT_SUMMARIZER_CONFIG.maxInputLength,
    minLines: DEFAULT_SUMMARIZER_CONFIG.minLines,
  };
}

const VALID_STRATEGIES: SummarizationStrategyType[] = ["template", "ml", "none"];

export function loadSummarizerStrategy(): SummarizationStrategyType {
  const stored = localStorage.getItem(STRATEGY_KEY);
  if (stored && VALID_STRATEGIES.includes(stored as SummarizationStrategyType)) {
    return stored as SummarizationStrategyType;
  }
  return DEFAULT_SUMMARIZER_CONFIG.strategy;
}

export function saveSummarizerStrategy(strategy: SummarizationStrategyType): void {
  localStorage.setItem(STRATEGY_KEY, strategy);
  // Keep the enabled flag in sync: "none" → disabled, otherwise → enabled
  localStorage.setItem(ENABLED_KEY, String(strategy !== "none"));
}
