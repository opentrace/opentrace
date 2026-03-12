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
import { extractTypeScript } from '../parser/extractors/typescript';
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
