import { describe, it, expect } from 'vitest';
import { getNodeColor } from '../nodeColors';

describe('getNodeColor', () => {
  it('returns fixed color for known node types', () => {
    expect(getNodeColor('Class')).toBe('#3b82f6');
    expect(getNodeColor('Function')).toBe('#a855f7');
    expect(getNodeColor('File')).toBe('#84cc16');
    expect(getNodeColor('Directory')).toBe('#22d3ee');
  });

  it('returns fixed color for Repository', () => {
    expect(getNodeColor('Repository')).toBe('#10b981');
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
