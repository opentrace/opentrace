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
import { getLinkColor } from '@opentrace/components/utils';

describe('getLinkColor', () => {
  it('returns fixed color for known relationship types', () => {
    expect(getLinkColor('CALLS')).toBe('#60a5fa');
    expect(getLinkColor('READS')).toBe('#fbbf24');
    expect(getLinkColor('WRITES')).toBe('#fb923c');
    expect(getLinkColor('DEFINED_IN')).toBe('#34d399');
    expect(getLinkColor('DEPENDS_ON')).toBe('#f472b6');
  });

  it('uppercases input before lookup', () => {
    expect(getLinkColor('calls')).toBe('#60a5fa');
    expect(getLinkColor('Reads')).toBe('#fbbf24');
    expect(getLinkColor('defined_in')).toBe('#34d399');
  });

  it('returns deterministic color for unknown types', () => {
    const color1 = getLinkColor('SOME_UNKNOWN_REL');
    const color2 = getLinkColor('SOME_UNKNOWN_REL');
    expect(color1).toBe(color2);
    expect(color1).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('unknown type case-insensitive', () => {
    expect(getLinkColor('custom_rel')).toBe(getLinkColor('CUSTOM_REL'));
  });
});
