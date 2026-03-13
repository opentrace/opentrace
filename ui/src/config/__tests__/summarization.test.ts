import { describe, it, expect } from 'vitest';
import {
  loadSummarizerConfig,
  loadSummarizerStrategy,
  saveSummarizerStrategy,
} from '../summarization';

describe('loadSummarizerConfig', () => {
  it('returns defaults when nothing stored', () => {
    const config = loadSummarizerConfig();
    expect(config.enabled).toBe(true);
    expect(config.strategy).toBe('template');
    expect(config.model).toBe('Xenova/flan-t5-small');
  });
});

describe('loadSummarizerStrategy', () => {
  it('defaults to template', () => {
    expect(loadSummarizerStrategy()).toBe('template');
  });

  it('validates against allowed strategies', () => {
    localStorage.setItem('ot_summarization_strategy', 'ml');
    expect(loadSummarizerStrategy()).toBe('ml');

    localStorage.setItem('ot_summarization_strategy', 'none');
    expect(loadSummarizerStrategy()).toBe('none');
  });

  it('returns default for invalid stored value', () => {
    localStorage.setItem('ot_summarization_strategy', 'bogus');
    expect(loadSummarizerStrategy()).toBe('template');
  });
});

describe('saveSummarizerStrategy', () => {
  it('saves "none" and sets enabled=false', () => {
    saveSummarizerStrategy('none');
    expect(localStorage.getItem('ot_summarization_strategy')).toBe('none');
    expect(localStorage.getItem('ot_summarization_enabled')).toBe('false');
  });

  it('saves "template" and sets enabled=true', () => {
    saveSummarizerStrategy('template');
    expect(localStorage.getItem('ot_summarization_strategy')).toBe('template');
    expect(localStorage.getItem('ot_summarization_enabled')).toBe('true');
  });

  it('saves "ml" and sets enabled=true', () => {
    saveSummarizerStrategy('ml');
    expect(localStorage.getItem('ot_summarization_enabled')).toBe('true');
  });
});
