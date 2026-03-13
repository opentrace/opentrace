// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// theme.ts has side effects at import (applyTheme(loadTheme())), so we
// must mock document.documentElement before each dynamic import.

describe('theme config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('loadTheme defaults to "clean"', async () => {
    const { loadTheme } = await import('../theme');
    expect(loadTheme()).toBe('clean');
  });

  it('loadMode defaults to "dark"', async () => {
    const { loadMode } = await import('../theme');
    expect(loadMode()).toBe('dark');
  });

  it('applyTheme sets document.documentElement.dataset.theme', async () => {
    const { applyTheme } = await import('../theme');
    applyTheme('amethyst-haze');
    expect(document.documentElement.dataset.theme).toBe('amethyst-haze');
  });

  it('applyMode sets document.documentElement.dataset.mode', async () => {
    const { applyMode } = await import('../theme');
    applyMode('light');
    expect(document.documentElement.dataset.mode).toBe('light');
  });

  it('loads saved theme from localStorage', async () => {
    localStorage.setItem('ot_theme', 'sunset-horizon');
    const { loadTheme } = await import('../theme');
    expect(loadTheme()).toBe('sunset-horizon');
  });

  it('loads saved mode from localStorage', async () => {
    localStorage.setItem('ot_mode', 'light');
    const { loadMode } = await import('../theme');
    expect(loadMode()).toBe('light');
  });
});
