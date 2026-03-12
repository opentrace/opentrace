/**
 * Fixture-driven tests for the TypeScript extractor and import analyzer.
 *
 * Extraction fixtures: tests/fixtures/typescript/extraction/*.ts + *.expected.json
 * Import fixtures:     tests/fixtures/typescript/imports/*.fixture.json
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTypeScript } from '../parser/extractors/typescript';
import { analyzeTypeScriptImports } from '../parser/importAnalyzer';
import { parseTS } from './helpers';
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
  'typescript',
);

// --- Extraction fixtures ---

const extractionDir = join(FIXTURE_ROOT, 'extraction');
const extractionFixtures = discoverExtractionFixtures(extractionDir, '.ts');

if (extractionFixtures.length > 0) {
  describe('typescript extraction fixtures', () => {
    for (const name of extractionFixtures) {
      it(name, async () => {
        const source = readFileSync(join(extractionDir, `${name}.ts`), 'utf-8');
        const expected = JSON.parse(
          readFileSync(join(extractionDir, `${name}.expected.json`), 'utf-8'),
        );

        const rootNode = await parseTS(source);
        const result = extractTypeScript(rootNode);
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
  describe('typescript import fixtures', () => {
    for (const name of importFixtures) {
      it(name, async () => {
        const fixture = JSON.parse(
          readFileSync(join(importsDir, `${name}.fixture.json`), 'utf-8'),
        );

        const rootNode = await parseTS(fixture.source);
        const knownFiles = new Set<string>(fixture.knownFiles);
        const result = analyzeTypeScriptImports(
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
