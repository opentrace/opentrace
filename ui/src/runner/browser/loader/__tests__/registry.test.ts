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
