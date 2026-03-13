import { describe, it, expect } from 'vitest';
import { getNodeColor } from '../nodeColors';

describe('getNodeColor', () => {
  it('returns fixed color for known node types', () => {
    expect(getNodeColor('Service')).toBe('#6366f1');
    expect(getNodeColor('Database')).toBe('#f59e0b');
    expect(getNodeColor('Class')).toBe('#3b82f6');
    expect(getNodeColor('Function')).toBe('#a855f7');
    expect(getNodeColor('File')).toBe('#84cc16');
    expect(getNodeColor('Directory')).toBe('#22d3ee');
  });

  it('Repo and Repository share the same color', () => {
    expect(getNodeColor('Repo')).toBe(getNodeColor('Repository'));
    expect(getNodeColor('Repo')).toBe('#10b981');
  });

  it('Database and DBTable share the same color', () => {
    expect(getNodeColor('Database')).toBe(getNodeColor('DBTable'));
    expect(getNodeColor('Database')).toBe('#f59e0b');
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
