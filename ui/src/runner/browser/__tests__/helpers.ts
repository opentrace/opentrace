/**
 * Test helpers: initialize web-tree-sitter in Node.js and load WASM parsers.
 *
 * In Node.js ESM, web-tree-sitter exports named members (Parser, Language, etc.)
 * rather than a default export. We use those directly.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { Parser, Language, type Node as SyntaxNode } from "web-tree-sitter";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "..", "..", "..", "..", "public");

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  const wasmBuf = await readFile(join(PUBLIC_DIR, "web-tree-sitter.wasm"));
  await Parser.init({
    locateFile: () => join(PUBLIC_DIR, "web-tree-sitter.wasm"),
    wasmBinary: wasmBuf,
  });
  initialized = true;
}

async function loadLanguage(wasmFile: string): Promise<Language> {
  const buf = await readFile(join(PUBLIC_DIR, wasmFile));
  return Language.load(buf);
}

let tsParser: Parser | null = null;
let tsxParser: Parser | null = null;
let goParser: Parser | null = null;
let pyParser: Parser | null = null;

export async function getTsParser(): Promise<Parser> {
  await ensureInit();
  if (!tsParser) {
    tsParser = new Parser();
    const lang = await loadLanguage("tree-sitter-typescript.wasm");
    tsParser.setLanguage(lang);
  }
  return tsParser;
}

export async function getTsxParser(): Promise<Parser> {
  await ensureInit();
  if (!tsxParser) {
    tsxParser = new Parser();
    const lang = await loadLanguage("tree-sitter-tsx.wasm");
    tsxParser.setLanguage(lang);
  }
  return tsxParser;
}

export async function getGoParser(): Promise<Parser> {
  await ensureInit();
  if (!goParser) {
    goParser = new Parser();
    const lang = await loadLanguage("tree-sitter-go.wasm");
    goParser.setLanguage(lang);
  }
  return goParser;
}

export async function getPyParser(): Promise<Parser> {
  await ensureInit();
  if (!pyParser) {
    pyParser = new Parser();
    const lang = await loadLanguage("tree-sitter-python.wasm");
    pyParser.setLanguage(lang);
  }
  return pyParser;
}

/** Parse TypeScript source and return root node. */
export async function parseTS(source: string): Promise<SyntaxNode> {
  const parser = await getTsParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error("Failed to parse TypeScript source");
  return tree.rootNode;
}

/** Parse TSX source and return root node. */
export async function parseTSX(source: string): Promise<SyntaxNode> {
  const parser = await getTsxParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error("Failed to parse TSX source");
  return tree.rootNode;
}

/** Parse Python source and return root node. */
export async function parsePy(source: string): Promise<SyntaxNode> {
  const parser = await getPyParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error("Failed to parse Python source");
  return tree.rootNode;
}

/** Parse Go source and return root node. */
export async function parseGo(source: string): Promise<SyntaxNode> {
  const parser = await getGoParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error("Failed to parse Go source");
  return tree.rootNode;
}
