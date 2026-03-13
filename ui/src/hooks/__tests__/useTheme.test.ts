// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../config/theme', () => ({
  loadTheme: vi.fn(() => 'clean'),
  loadMode: vi.fn(() => 'dark' as const),
  applyTheme: vi.fn(),
  applyMode: vi.fn(),
}));

import { useTheme } from '../useTheme';
import { applyTheme, applyMode } from '../../config/theme';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useTheme', () => {
  it('initializes from loadTheme and loadMode', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('clean');
    expect(result.current.mode).toBe('dark');
  });

  it('setTheme calls applyTheme', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.setTheme('amethyst-haze');
    });
    expect(result.current.theme).toBe('amethyst-haze');
    expect(applyTheme).toHaveBeenCalledWith('amethyst-haze');
  });

  it('toggleMode flips dark to light', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('dark');
    act(() => {
      result.current.toggleMode();
    });
    expect(result.current.mode).toBe('light');
    expect(applyMode).toHaveBeenCalledWith('light');
  });

  it('toggleMode flips light back to dark', () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.toggleMode(); // dark → light
    });
    act(() => {
      result.current.toggleMode(); // light → dark
    });
    expect(result.current.mode).toBe('dark');
  });
});
