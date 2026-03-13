import { describe, it, expect } from 'vitest';
import { loaderRegistry } from '../registry';

describe('loaderRegistry', () => {
  it('contains 3 loaders in correct order', () => {
    expect(loaderRegistry).toHaveLength(3);
    const names = loaderRegistry.map((l) => l.name);
    // directory first, then gitlab, then github
    expect(names[0]).toMatch(/directory/i);
    expect(names[1]).toMatch(/gitlab/i);
    expect(names[2]).toMatch(/github/i);
  });

  it('all loaders have name, canHandle, and load', () => {
    for (const loader of loaderRegistry) {
      expect(typeof loader.name).toBe('string');
      expect(typeof loader.canHandle).toBe('function');
      expect(typeof loader.load).toBe('function');
    }
  });
});
