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
