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
    // Real Google API keys are exactly `AIza` + 35 url-safe chars (39 total).
    expect(detectProvider('AIza' + 'A'.repeat(35))).toBe('gemini');
  });

  it('does not match AIza strings of the wrong length', () => {
    expect(detectProvider('AIza')).toBeNull();
    expect(detectProvider('AIza' + 'A'.repeat(20))).toBeNull(); // too short
    expect(detectProvider('AIza' + 'A'.repeat(50))).toBeNull(); // too long
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
