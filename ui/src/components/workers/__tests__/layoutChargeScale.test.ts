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

import { describe, expect, it } from 'vitest';

import { modeChargeStrength, treeRelax } from '../layoutChargeScale';

describe('treeRelax', () => {
  it('is full strength below ~600 nodes', () => {
    expect(treeRelax(1)).toBe(1);
    expect(treeRelax(400)).toBe(1);
    expect(treeRelax(600)).toBe(1);
  });

  it('fades toward near-zero as graphs grow', () => {
    expect(treeRelax(1200)).toBeCloseTo(0.5);
    expect(treeRelax(6000)).toBeCloseTo(0.1);
  });

  it('guards against a zero node count', () => {
    expect(treeRelax(0)).toBe(1);
  });
});

describe('modeChargeStrength', () => {
  it('passes spread/compact through unscaled', () => {
    expect(modeChargeStrength('spread', -300, 1000)).toBe(-300);
    expect(modeChargeStrength('compact', -300, 1000)).toBe(-300);
  });

  it('returns null for onion (mode deliberately runs NO charge force)', () => {
    expect(modeChargeStrength('onion', -300, 1000)).toBeNull();
  });

  it('scales tree by 0.4 × relax (matches buildSimulation)', () => {
    expect(modeChargeStrength('tree', -300, 400)).toBeCloseTo(-300 * 0.4);
    expect(modeChargeStrength('tree', -300, 1200)).toBeCloseTo(
      -300 * 0.4 * 0.5,
    );
  });

  it('scales nebula by 0.12 (matches buildSimulation)', () => {
    expect(modeChargeStrength('nebula', -300, 1000)).toBeCloseTo(-300 * 0.12);
  });
});
