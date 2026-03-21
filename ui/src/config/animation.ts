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

export interface AnimationSettings {
  selectionPulse: boolean;
}

const LS_PREFIX = 'ot:anim:';

const DEFAULTS: AnimationSettings = {
  selectionPulse: true,
};

export function loadAnimationSettings(): AnimationSettings {
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof AnimationSettings)[]) {
    const stored = localStorage.getItem(`${LS_PREFIX}${key}`);
    if (stored !== null) {
      settings[key] = stored === 'true';
    }
  }
  return settings;
}

export function saveAnimationSetting(
  key: keyof AnimationSettings,
  value: boolean,
): void {
  localStorage.setItem(`${LS_PREFIX}${key}`, String(value));
}

export const ANIMATION_DEFAULTS = DEFAULTS;
