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
