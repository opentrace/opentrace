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
 * Fixture-driven tests for the Python extractor and import analyzer.
 *
 * Extraction fixtures: tests/fixtures/python/extraction/*.py + *.expected.json
 * Import fixtures:     tests/fixtures/python/imports/*.fixture.json
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPython, analyzePythonImports } from '@opentrace/components/pipeline';
import { parsePy } from './helpers';
import {
  normalizeSymbol,
  discoverExtractionFixtures,
  discoverImportFixtures,
} from './normalizers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'python',
);

// --- Extraction fixtures ---

const extractionDir = join(FIXTURE_ROOT, 'extraction');
const extractionFixtures = discoverExtractionFixtures(extractionDir, '.py');

if (extractionFixtures.length > 0) {
  describe('python extraction fixtures', () => {
    for (const name of extractionFixtures) {
      it(name, async () => {
        const source = readFileSync(join(extractionDir, `${name}.py`), 'utf-8');
        const expected = JSON.parse(
          readFileSync(join(extractionDir, `${name}.expected.json`), 'utf-8'),
        );

        const rootNode = await parsePy(source);
        const result = extractPython(rootNode);
        const actual = result.symbols.map(normalizeSymbol);

        expect(actual).toEqual(expected);
      });
    }
  });
}

// --- Import fixtures ---

const importsDir = join(FIXTURE_ROOT, 'imports');
const importFixtures = discoverImportFixtures(importsDir);

if (importFixtures.length > 0) {
  describe('python import fixtures', () => {
    for (const name of importFixtures) {
      it(name, async () => {
        const fixture = JSON.parse(
          readFileSync(join(importsDir, `${name}.fixture.json`), 'utf-8'),
        );

        const rootNode = await parsePy(fixture.source);
        const knownFiles = new Set<string>(fixture.knownFiles);
        const result = analyzePythonImports(
          rootNode,
          fixture.filePath,
          knownFiles,
        );

        expect(result.internal).toEqual(fixture.expected.internal);
        expect(result.external).toEqual(fixture.expected.external);
      });
    }
  });
}
