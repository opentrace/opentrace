/**
 * Generate .expected.json files for generic extractor fixtures.
 *
 * Usage: node scripts/generate-generic-fixtures.mjs
 *
 * Reads source files from tests/fixtures/{lang}/extraction/, runs them through
 * the generic extractor, and writes the normalized output as .expected.json.
 */
import { Parser, Language } from 'web-tree-sitter';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', 'public');
const FIXTURE_ROOT = join(__dirname, '..', '..', 'tests', 'fixtures');

// Import the extractor (it's pure TS, needs to be loaded via dynamic import after build)
// Instead, we inline the normalizer logic here to avoid build step dependency.

const LANGUAGES = [
  { lang: 'c', ext: '.c', wasm: 'tree-sitter-c.wasm' },
  { lang: 'cpp', ext: '.cpp', wasm: 'tree-sitter-cpp.wasm' },
  { lang: 'csharp', ext: '.cs', wasm: 'tree-sitter-c_sharp.wasm' },
  { lang: 'java', ext: '.java', wasm: 'tree-sitter-java.wasm' },
  { lang: 'kotlin', ext: '.kt', wasm: 'tree-sitter-kotlin.wasm' },
  { lang: 'ruby', ext: '.rb', wasm: 'tree-sitter-ruby.wasm' },
  { lang: 'rust', ext: '.rs', wasm: 'tree-sitter-rust.wasm' },
  { lang: 'swift', ext: '.swift', wasm: 'tree-sitter-swift.wasm' },
];

// We need the extractGeneric function. Since it's TypeScript, we'll use tsx to run this.
// Alternative: duplicate the logic here. Let's use a simpler approach — run via vitest.

// Actually, let's write a vitest script that generates the fixtures.
console.log(
  'This script should be run via: npx vitest run scripts/generate-generic-fixtures.test.mjs',
);
console.log('Or use the inline generation approach below.');

// Inline approach: use web-tree-sitter directly and replicate extractGeneric logic.
// This is fragile, so instead we provide a test-based generator.

/** Normalizer matching normalizeSymbolGeneric */
function normalize(sym) {
  return {
    name: sym.name,
    kind: sym.kind,
    start_line: sym.startLine,
    end_line: sym.endLine,
    signature: sym.signature,
    subtype: sym.subtype ?? null,
    superclasses: sym.superclasses ?? null,
    interfaces: sym.interfaces ?? null,
    children: sym.children.map(normalize),
    calls: [],
  };
}

async function main() {
  const wasmBuf = readFileSync(join(PUBLIC_DIR, 'web-tree-sitter.wasm'));
  await Parser.init({
    locateFile: () => join(PUBLIC_DIR, 'web-tree-sitter.wasm'),
    wasmBinary: wasmBuf,
  });

  // Dynamically import the extractor (works if running via tsx or after build)
  let extractGeneric;
  try {
    const mod =
      await import('../src/runner/browser/parser/extractors/generic.ts');
    extractGeneric = mod.extractGeneric;
  } catch {
    console.error(
      'Could not import extractGeneric. Run with: npx tsx scripts/generate-generic-fixtures.mjs',
    );
    process.exit(1);
  }

  let totalGenerated = 0;

  for (const { lang, ext, wasm } of LANGUAGES) {
    const extractionDir = join(FIXTURE_ROOT, lang, 'extraction');
    if (!existsSync(extractionDir)) continue;

    const parser = new Parser();
    const langBuf = readFileSync(join(PUBLIC_DIR, wasm));
    const language = await Language.load(langBuf);
    parser.setLanguage(language);

    const sourceFiles = readdirSync(extractionDir).filter((f) =>
      f.endsWith(ext),
    );

    for (const sourceFile of sourceFiles) {
      const name = sourceFile.slice(0, -ext.length);
      const source = readFileSync(join(extractionDir, sourceFile), 'utf-8');
      const tree = parser.parse(source);
      if (!tree) {
        console.warn(`  WARN: failed to parse ${sourceFile}`);
        continue;
      }

      const result = extractGeneric(tree.rootNode, lang);
      const normalized = result.symbols.map(normalize);
      const outPath = join(extractionDir, `${name}.expected.json`);
      writeFileSync(outPath, JSON.stringify(normalized, null, 2) + '\n');
      console.log(`  ${lang}/${name}.expected.json`);
      totalGenerated++;
    }
  }

  console.log(`\nGenerated ${totalGenerated} fixture files.`);
}

main().catch(console.error);
