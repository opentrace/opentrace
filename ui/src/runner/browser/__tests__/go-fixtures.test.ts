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
 * Fixture-driven tests for the Go extractor and import analyzer.
 *
 * Extraction fixtures: tests/fixtures/go/extraction/*.go + *.expected.json
 *   Expected JSON includes receiver_var / receiver_type fields.
 * Import fixtures:     tests/fixtures/go/imports/*.fixture.json
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGo } from '../parser/extractors/go';
import { analyzeGoImports } from '../parser/importAnalyzer';
import { parseGo } from './helpers';
import {
  normalizeSymbolFull,
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
  'go',
);

// --- Extraction fixtures ---

const extractionDir = join(FIXTURE_ROOT, 'extraction');
const extractionFixtures = discoverExtractionFixtures(extractionDir, '.go');

if (extractionFixtures.length > 0) {
  describe('go extraction fixtures', () => {
    for (const name of extractionFixtures) {
      it(name, async () => {
        const source = readFileSync(join(extractionDir, `${name}.go`), 'utf-8');
        const expected = JSON.parse(
          readFileSync(join(extractionDir, `${name}.expected.json`), 'utf-8'),
        );

        const rootNode = await parseGo(source);
        const result = extractGo(rootNode);
        const actual = result.symbols.map(normalizeSymbolFull);

        expect(actual).toEqual(expected);
      });
    }
  });
}

// --- Import fixtures ---

const importsDir = join(FIXTURE_ROOT, 'imports');
const importFixtures = discoverImportFixtures(importsDir);

if (importFixtures.length > 0) {
  describe('go import fixtures', () => {
    for (const name of importFixtures) {
      it(name, async () => {
        const fixture = JSON.parse(
          readFileSync(join(importsDir, `${name}.fixture.json`), 'utf-8'),
        );

        const rootNode = await parseGo(fixture.source);
        const knownFiles = new Set<string>(fixture.knownFiles);
        const result = analyzeGoImports(
          rootNode,
          knownFiles,
          fixture.modulePath ?? undefined,
        );

        expect(result.internal).toEqual(fixture.expected.internal);
        expect(result.external).toEqual(fixture.expected.external);
      });
    }
  });
}
