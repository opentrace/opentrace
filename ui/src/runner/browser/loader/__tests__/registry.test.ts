import { describe, it, expect } from 'vitest';
import { loaderRegistry } from '../registry';

describe('loaderRegistry', () => {
  it('contains 5 loaders in correct order', () => {
    expect(loaderRegistry).toHaveLength(5);
    const names = loaderRegistry.map((l) => l.name);
    // directory first, then gitlab, azuredevops, bitbucket, github
    expect(names[0]).toMatch(/directory/i);
    expect(names[1]).toMatch(/gitlab/i);
    expect(names[2]).toMatch(/azuredevops/i);
    expect(names[3]).toMatch(/bitbucket/i);
    expect(names[4]).toMatch(/github/i);
  });

  it('all loaders have name, canHandle, and load', () => {
    for (const loader of loaderRegistry) {
      expect(typeof loader.name).toBe('string');
      expect(typeof loader.canHandle).toBe('function');
      expect(typeof loader.load).toBe('function');
    }
  });
});
