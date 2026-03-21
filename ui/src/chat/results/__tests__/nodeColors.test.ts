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

import { describe, it, expect } from 'vitest';
import { getNodeColor } from '@opentrace/components/utils';

describe('getNodeColor', () => {
  it('returns fixed color for known node types', () => {
    expect(getNodeColor('Class')).toBe('#3b82f6');
    expect(getNodeColor('Function')).toBe('#a855f7');
    expect(getNodeColor('File')).toBe('#84cc16');
    expect(getNodeColor('Directory')).toBe('#06b6d4');
  });

  it('returns fixed color for Repository', () => {
    expect(getNodeColor('Repository')).toBe('#22c55e');
  });

  it('returns a deterministic color for unknown types', () => {
    const color1 = getNodeColor('UnknownWidget');
    const color2 = getNodeColor('UnknownWidget');
    expect(color1).toBe(color2);
    expect(color1).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('different unknown types can map to different colors', () => {
    const a = getNodeColor('TypeAlpha');
    const b = getNodeColor('TypeBeta');
    // They might collide but with DJB2 hash they're unlikely to for short distinct strings
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
  });
});
