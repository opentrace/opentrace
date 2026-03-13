import { describe, it, expect } from 'vitest';
import {
  loadApiKey,
  saveApiKey,
  loadProviderChoice,
  saveProviderChoice,
  loadModelChoice,
  saveModelChoice,
} from '../storage';

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
    it('defaults to anthropic', () => {
      expect(loadProviderChoice()).toBe('anthropic');
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
