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
 * Fixture-driven tests for the generic extractor across all supported languages.
 *
 * Extraction fixtures: tests/fixtures/{lang}/extraction/{name}.{ext} + {name}.expected.json
 *
 * Each language directory follows the same pattern as Go/TS/Python fixtures.
 * Expected JSON uses the generic normalizer (includes subtype/superclasses/interfaces).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGeneric } from '@opentrace/components/pipeline';
import {
  parseRust,
  parseJava,
  parseCpp,
  parseC,
  parseRuby,
  parseCsharp,
  parseKotlin,
  parseSwift,
  parsePhp,
} from './helpers';
import {
  normalizeSymbolGeneric,
  discoverExtractionFixtures,
} from './normalizers';
import type { Node as SyntaxNode } from 'web-tree-sitter';

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
);

/** Language config: source extension, language key, and parser function. */
const GENERIC_LANGUAGES: Array<{
  name: string;
  ext: string;
  lang: string;
  parse: (source: string) => Promise<SyntaxNode>;
}> = [
  { name: 'C', ext: '.c', lang: 'c', parse: parseC },
  { name: 'C++', ext: '.cpp', lang: 'cpp', parse: parseCpp },
  { name: 'C#', ext: '.cs', lang: 'csharp', parse: parseCsharp },
  { name: 'Java', ext: '.java', lang: 'java', parse: parseJava },
  { name: 'Kotlin', ext: '.kt', lang: 'kotlin', parse: parseKotlin },
  { name: 'Ruby', ext: '.rb', lang: 'ruby', parse: parseRuby },
  { name: 'Rust', ext: '.rs', lang: 'rust', parse: parseRust },
  { name: 'Swift', ext: '.swift', lang: 'swift', parse: parseSwift },
  { name: 'PHP', ext: '.php', lang: 'php', parse: parsePhp },
];

for (const { name, ext, lang, parse } of GENERIC_LANGUAGES) {
  const extractionDir = join(FIXTURE_ROOT, lang, 'extraction');
  const fixtures = discoverExtractionFixtures(extractionDir, ext);

  if (fixtures.length > 0) {
    describe(`${name} extraction fixtures`, () => {
      for (const fixtureName of fixtures) {
        it(fixtureName, async () => {
          const source = readFileSync(
            join(extractionDir, `${fixtureName}${ext}`),
            'utf-8',
          );
          const expected = JSON.parse(
            readFileSync(
              join(extractionDir, `${fixtureName}.expected.json`),
              'utf-8',
            ),
          );

          const rootNode = await parse(source);
          const result = extractGeneric(rootNode, lang);
          const actual = result.symbols.map(normalizeSymbolGeneric);

          expect(actual).toEqual(expected);
        });
      }
    });
  }
}
