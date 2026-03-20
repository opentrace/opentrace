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

import type {
  SummarizerConfig,
  SummarizationStrategyType,
} from '@opentrace/components/pipeline';
import { DEFAULT_SUMMARIZER_CONFIG } from '@opentrace/components/pipeline';

const ENABLED_KEY = 'ot_summarization_enabled';
const MODEL_KEY = 'ot_summarization_model';
const STRATEGY_KEY = 'ot_summarization_strategy';
const LLM_URL_KEY = 'ot_summarization_llm_url';
const LLM_MODEL_KEY = 'ot_summarization_llm_model';

export function loadSummarizerConfig(): SummarizerConfig {
  const stored = localStorage.getItem(ENABLED_KEY);
  const enabled = stored === null ? true : stored === 'true';
  const model =
    localStorage.getItem(MODEL_KEY) || DEFAULT_SUMMARIZER_CONFIG.model;
  const strategy = loadSummarizerStrategy();
  const llmUrl = localStorage.getItem(LLM_URL_KEY) ?? undefined;
  const llmModel = localStorage.getItem(LLM_MODEL_KEY) ?? undefined;
  return {
    enabled,
    strategy,
    model,
    maxInputLength: DEFAULT_SUMMARIZER_CONFIG.maxInputLength,
    minLines: DEFAULT_SUMMARIZER_CONFIG.minLines,
    llmUrl,
    llmModel,
  };
}

export function loadSummarizerLlmConfig(): { url: string; model: string } {
  return {
    url:
      localStorage.getItem(LLM_URL_KEY) ??
      `${window.location.protocol}//${window.location.hostname}:11434`,
    model: localStorage.getItem(LLM_MODEL_KEY) ?? 'llama3.2',
  };
}

export function saveSummarizerLlmConfig(url: string, model: string): void {
  if (url) localStorage.setItem(LLM_URL_KEY, url);
  else localStorage.removeItem(LLM_URL_KEY);
  if (model) localStorage.setItem(LLM_MODEL_KEY, model);
  else localStorage.removeItem(LLM_MODEL_KEY);
}

const VALID_STRATEGIES: SummarizationStrategyType[] = [
  'template',
  'ml',
  'llm',
  'none',
];

export function loadSummarizerStrategy(): SummarizationStrategyType {
  const stored = localStorage.getItem(STRATEGY_KEY);
  if (
    stored &&
    VALID_STRATEGIES.includes(stored as SummarizationStrategyType)
  ) {
    return stored as SummarizationStrategyType;
  }
  return DEFAULT_SUMMARIZER_CONFIG.strategy;
}

export function saveSummarizerStrategy(
  strategy: SummarizationStrategyType,
): void {
  localStorage.setItem(STRATEGY_KEY, strategy);
  // Keep the enabled flag in sync: "none" → disabled, otherwise → enabled
  localStorage.setItem(ENABLED_KEY, String(strategy !== 'none'));
}
