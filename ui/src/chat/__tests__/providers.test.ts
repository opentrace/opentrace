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
import { detectProvider } from '../providers';

describe('detectProvider', () => {
  it('detects Anthropic keys (sk-ant- prefix)', () => {
    expect(detectProvider('sk-ant-api03-AbCdEf123456')).toBe('anthropic');
  });

  it('detects OpenAI keys (sk- and sk-proj-)', () => {
    expect(detectProvider('sk-AbCdEf1234567890')).toBe('openai');
    expect(detectProvider('sk-proj-AbCdEf1234567890')).toBe('openai');
  });

  it('prefers Anthropic over OpenAI since both start with sk-', () => {
    // sk-ant- must win the sk- contest.
    expect(detectProvider('sk-ant-xyz')).toBe('anthropic');
  });

  it('detects Gemini keys (AIza prefix)', () => {
    expect(detectProvider('AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6')).toBe(
      'gemini',
    );
  });

  it('does not match a bare AIza without enough length', () => {
    expect(detectProvider('AIza')).toBeNull();
  });

  it('trims surrounding whitespace before matching', () => {
    expect(detectProvider('  sk-ant-key  ')).toBe('anthropic');
  });

  it('returns null for empty or unrecognized keys', () => {
    expect(detectProvider('')).toBeNull();
    expect(detectProvider('   ')).toBeNull();
    expect(detectProvider('hf_huggingfacetoken')).toBeNull();
    expect(detectProvider('random-string')).toBeNull();
  });

  it('never auto-detects the local provider', () => {
    // Local has no detectable key; it stays an explicit choice.
    expect(detectProvider('llama3.2')).toBeNull();
  });
});
