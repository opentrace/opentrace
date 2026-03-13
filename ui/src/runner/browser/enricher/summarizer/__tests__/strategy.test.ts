import { describe, it, expect } from 'vitest';
import { createStrategy } from '../strategy';
import { DEFAULT_SUMMARIZER_CONFIG } from '../types';

describe('createStrategy', () => {
  it('enabled:false returns NoopStrategy', () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      enabled: false,
    });
    expect(strategy.type).toBe('none');
  });

  it('strategy:"template" returns TemplateStrategy', () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      enabled: true,
      strategy: 'template',
    });
    expect(strategy.type).toBe('template');
  });

  it('strategy:"none" returns NoopStrategy', () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      strategy: 'none',
    });
    expect(strategy.type).toBe('none');
  });

  it('strategy:"ml" returns MlStrategy', () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      enabled: true,
      strategy: 'ml',
    });
    expect(strategy.type).toBe('ml');
  });
});

describe('NoopStrategy', () => {
  it('summarizeBatch returns array of empty strings', async () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      enabled: false,
    });
    await strategy.init();
    const results = await strategy.summarizeBatch([
      { name: 'foo', kind: 'function' },
      { name: 'bar', kind: 'class' },
    ]);
    expect(results).toEqual(['', '']);
  });

  it('summarize returns empty string', async () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      strategy: 'none',
    });
    const result = await strategy.summarize({ name: 'test', kind: 'function' });
    expect(result).toBe('');
  });
});

describe('TemplateStrategy', () => {
  it('delegates to summarizeFromMetadata', async () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      enabled: true,
      strategy: 'template',
    });
    await strategy.init();
    const result = await strategy.summarize({
      name: 'getUserById',
      kind: 'function',
    });
    expect(result).toBe('Retrieves user by id');
  });

  it('summarizeBatch returns non-empty strings', async () => {
    const strategy = createStrategy({
      ...DEFAULT_SUMMARIZER_CONFIG,
      enabled: true,
      strategy: 'template',
    });
    const results = await strategy.summarizeBatch([
      { name: 'createUser', kind: 'function' },
      { name: 'UserService', kind: 'class' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('Creates');
    expect(results[1]).toContain('User service');
  });
});
