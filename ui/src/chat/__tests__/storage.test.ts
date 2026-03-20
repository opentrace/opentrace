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
import {
  loadApiKey,
  saveApiKey,
  loadProviderChoice,
  saveProviderChoice,
  loadModelChoice,
  saveModelChoice,
} from '@opentrace/components/chat';

describe('storage', () => {
  describe('loadApiKey / saveApiKey', () => {
    it('returns empty string when nothing stored', () => {
      expect(loadApiKey('anthropic')).toBe('');
    });

    it('stores under ot_chat_apikey_{provider}', () => {
      saveApiKey('anthropic', 'sk-test-123');
      expect(loadApiKey('anthropic')).toBe('sk-test-123');
    });

    it('saving empty string removes the key', () => {
      saveApiKey('openai', 'sk-foo');
      expect(loadApiKey('openai')).toBe('sk-foo');
      saveApiKey('openai', '');
      expect(loadApiKey('openai')).toBe('');
    });

    it('keys are namespaced per provider', () => {
      saveApiKey('anthropic', 'key-a');
      saveApiKey('openai', 'key-o');
      expect(loadApiKey('anthropic')).toBe('key-a');
      expect(loadApiKey('openai')).toBe('key-o');
    });
  });

  describe('loadProviderChoice / saveProviderChoice', () => {
    it('defaults to gemini', () => {
      expect(loadProviderChoice()).toBe('gemini');
    });

    it('saves and loads provider', () => {
      saveProviderChoice('openai');
      expect(loadProviderChoice()).toBe('openai');
    });
  });

  describe('loadModelChoice / saveModelChoice', () => {
    it('returns null when nothing stored', () => {
      expect(loadModelChoice('anthropic')).toBeNull();
    });

    it('saves and loads model per provider', () => {
      saveModelChoice('anthropic', 'claude-3-opus');
      saveModelChoice('openai', 'gpt-4');
      expect(loadModelChoice('anthropic')).toBe('claude-3-opus');
      expect(loadModelChoice('openai')).toBe('gpt-4');
    });
  });
});
