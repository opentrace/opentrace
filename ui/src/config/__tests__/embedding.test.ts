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

import { describe, it, expect } from 'vitest';
import { loadEmbedderConfig } from '../embedding';

describe('loadEmbedderConfig', () => {
  it('returns defaults when nothing stored', () => {
    const config = loadEmbedderConfig();
    expect(config.enabled).toBe(true);
    expect(config.model).toBe('Xenova/all-MiniLM-L6-v2');
  });

  it('parses "true"/"false" string for enabled', () => {
    localStorage.setItem('ot_embedding_enabled', 'false');
    expect(loadEmbedderConfig().enabled).toBe(false);

    localStorage.setItem('ot_embedding_enabled', 'true');
    expect(loadEmbedderConfig().enabled).toBe(true);
  });

  it('reads custom model from localStorage', () => {
    localStorage.setItem('ot_embedding_model', 'custom/model-v2');
    expect(loadEmbedderConfig().model).toBe('custom/model-v2');
  });
});
