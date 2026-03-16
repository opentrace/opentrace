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
