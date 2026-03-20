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

/**
 * Cross-validation: verify TS extractor output matches shared expected fixtures.
 *
 * Uses the same .txt + .expected.json fixture pairs as the Python tests,
 * proving both extractors produce identical output.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { extractTypeScript } from '@opentrace/components/pipeline';
import { parseTS } from './helpers';
import { normalizeSymbol } from './normalizers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'cross-validation',
);

// Discover fixtures dynamically
const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => f.replace('.txt', ''));

describe('cross-validation: TS extractor matches expected', () => {
  for (const fixtureName of fixtures) {
    it(fixtureName, async () => {
      const source = readFileSync(
        join(FIXTURE_DIR, `${fixtureName}.txt`),
        'utf-8',
      );
      const expected = JSON.parse(
        readFileSync(
          join(FIXTURE_DIR, `${fixtureName}.expected.json`),
          'utf-8',
        ),
      );

      const rootNode = await parseTS(source);
      const result = extractTypeScript(rootNode);
      const actual = result.symbols.map(normalizeSymbol);

      expect(actual).toEqual(expected);
    });
  }
});
