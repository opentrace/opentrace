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

import type { EmbedderConfig } from '../runner/browser/enricher/embedder/types';
import { DEFAULT_EMBEDDER_CONFIG } from '../runner/browser/enricher/embedder/types';

const ENABLED_KEY = 'ot_embedding_enabled';
const MODEL_KEY = 'ot_embedding_model';

export function loadEmbedderConfig(): EmbedderConfig {
  const stored = localStorage.getItem(ENABLED_KEY);
  const enabled =
    stored === null ? DEFAULT_EMBEDDER_CONFIG.enabled : stored === 'true';
  const model =
    localStorage.getItem(MODEL_KEY) || DEFAULT_EMBEDDER_CONFIG.model;
  return { enabled, model };
}
