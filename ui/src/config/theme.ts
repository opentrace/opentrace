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

const THEME_KEY = 'ot_theme';
const MODE_KEY = 'ot_mode';

export const THEMES = [
  { value: 'clean', label: 'Clean' },
  { value: 'default', label: 'Default' },
  { value: 'amethyst-haze', label: 'Amethyst Haze' },
  { value: 'sunset-horizon', label: 'Sunset Horizon' },
  { value: 'tangerine', label: 'Tangerine' },
  { value: 'emerald', label: 'Emerald' },
  { value: 'midnight-tokyo', label: 'Midnight Tokyo' },
] as const;

export function loadTheme(): string {
  return localStorage.getItem(THEME_KEY) ?? 'clean';
}

export function loadMode(): 'light' | 'dark' {
  return (localStorage.getItem(MODE_KEY) as 'light' | 'dark') ?? 'dark';
}

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

export function applyMode(mode: 'light' | 'dark') {
  document.documentElement.dataset.mode = mode;
  localStorage.setItem(MODE_KEY, mode);
}

// Apply saved theme + mode immediately on module load (before first paint)
applyTheme(loadTheme());
applyMode(loadMode());
