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
    expect(getLinkColor('CALLS')).toBe('#93c5fd');
    expect(getLinkColor('DEFINES')).toBe('#6ee7b7');
    expect(getLinkColor('DEPENDS')).toBe('#f9a8d4');
    expect(getLinkColor('IMPORTS')).toBe('#d8b4fe');
    expect(getLinkColor('CHANGES')).toBe('#fca5a5');
  });

  it('returns deterministic color for unknown types', () => {
    const color1 = getLinkColor('SomeUnknownRel');
    const color2 = getLinkColor('SomeUnknownRel');
    expect(color1).toBe(color2);
    expect(color1).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('different casing of unknown types gives different colors', () => {
    expect(getLinkColor('CustomRel')).not.toBe(getLinkColor('CUSTOM_REL'));
  });
});
