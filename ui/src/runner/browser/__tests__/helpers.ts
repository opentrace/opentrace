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
 * Test helpers: initialize web-tree-sitter in Node.js and load WASM parsers.
 *
 * In Node.js ESM, web-tree-sitter exports named members (Parser, Language, etc.)
 * rather than a default export. We use those directly.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'components',
  'public',
  'wasm',
);

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) return;
  const wasmBuf = await readFile(join(PUBLIC_DIR, 'web-tree-sitter.wasm'));
  await Parser.init({
    locateFile: () => join(PUBLIC_DIR, 'web-tree-sitter.wasm'),
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
let rustParser: Parser | null = null;
let javaParser: Parser | null = null;
let cppParser: Parser | null = null;
let cParser: Parser | null = null;
let rubyParser: Parser | null = null;
let csharpParser: Parser | null = null;
let kotlinParser: Parser | null = null;
let swiftParser: Parser | null = null;

export async function getTsParser(): Promise<Parser> {
  await ensureInit();
  if (!tsParser) {
    tsParser = new Parser();
    const lang = await loadLanguage('tree-sitter-typescript.wasm');
    tsParser.setLanguage(lang);
  }
  return tsParser;
}

export async function getTsxParser(): Promise<Parser> {
  await ensureInit();
  if (!tsxParser) {
    tsxParser = new Parser();
    const lang = await loadLanguage('tree-sitter-tsx.wasm');
    tsxParser.setLanguage(lang);
  }
  return tsxParser;
}

export async function getGoParser(): Promise<Parser> {
  await ensureInit();
  if (!goParser) {
    goParser = new Parser();
    const lang = await loadLanguage('tree-sitter-go.wasm');
    goParser.setLanguage(lang);
  }
  return goParser;
}

export async function getPyParser(): Promise<Parser> {
  await ensureInit();
  if (!pyParser) {
    pyParser = new Parser();
    const lang = await loadLanguage('tree-sitter-python.wasm');
    pyParser.setLanguage(lang);
  }
  return pyParser;
}

/** Parse TypeScript source and return root node. */
export async function parseTS(source: string): Promise<SyntaxNode> {
  const parser = await getTsParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse TypeScript source');
  return tree.rootNode;
}

/** Parse TSX source and return root node. */
export async function parseTSX(source: string): Promise<SyntaxNode> {
  const parser = await getTsxParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse TSX source');
  return tree.rootNode;
}

/** Parse Python source and return root node. */
export async function parsePy(source: string): Promise<SyntaxNode> {
  const parser = await getPyParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Python source');
  return tree.rootNode;
}

/** Parse Go source and return root node. */
export async function parseGo(source: string): Promise<SyntaxNode> {
  const parser = await getGoParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Go source');
  return tree.rootNode;
}

export async function getRustParser(): Promise<Parser> {
  await ensureInit();
  if (!rustParser) {
    rustParser = new Parser();
    const lang = await loadLanguage('tree-sitter-rust.wasm');
    rustParser.setLanguage(lang);
  }
  return rustParser;
}

export async function getJavaParser(): Promise<Parser> {
  await ensureInit();
  if (!javaParser) {
    javaParser = new Parser();
    const lang = await loadLanguage('tree-sitter-java.wasm');
    javaParser.setLanguage(lang);
  }
  return javaParser;
}

export async function getCppParser(): Promise<Parser> {
  await ensureInit();
  if (!cppParser) {
    cppParser = new Parser();
    const lang = await loadLanguage('tree-sitter-cpp.wasm');
    cppParser.setLanguage(lang);
  }
  return cppParser;
}

export async function getCParser(): Promise<Parser> {
  await ensureInit();
  if (!cParser) {
    cParser = new Parser();
    const lang = await loadLanguage('tree-sitter-c.wasm');
    cParser.setLanguage(lang);
  }
  return cParser;
}

export async function getRubyParser(): Promise<Parser> {
  await ensureInit();
  if (!rubyParser) {
    rubyParser = new Parser();
    const lang = await loadLanguage('tree-sitter-ruby.wasm');
    rubyParser.setLanguage(lang);
  }
  return rubyParser;
}

export async function getCsharpParser(): Promise<Parser> {
  await ensureInit();
  if (!csharpParser) {
    csharpParser = new Parser();
    const lang = await loadLanguage('tree-sitter-c_sharp.wasm');
    csharpParser.setLanguage(lang);
  }
  return csharpParser;
}

export async function getKotlinParser(): Promise<Parser> {
  await ensureInit();
  if (!kotlinParser) {
    kotlinParser = new Parser();
    const lang = await loadLanguage('tree-sitter-kotlin.wasm');
    kotlinParser.setLanguage(lang);
  }
  return kotlinParser;
}

export async function getSwiftParser(): Promise<Parser> {
  await ensureInit();
  if (!swiftParser) {
    swiftParser = new Parser();
    const lang = await loadLanguage('tree-sitter-swift.wasm');
    swiftParser.setLanguage(lang);
  }
  return swiftParser;
}

/** Parse Rust source and return root node. */
export async function parseRust(source: string): Promise<SyntaxNode> {
  const parser = await getRustParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Rust source');
  return tree.rootNode;
}

/** Parse Java source and return root node. */
export async function parseJava(source: string): Promise<SyntaxNode> {
  const parser = await getJavaParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Java source');
  return tree.rootNode;
}

/** Parse C++ source and return root node. */
export async function parseCpp(source: string): Promise<SyntaxNode> {
  const parser = await getCppParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse C++ source');
  return tree.rootNode;
}

/** Parse C source and return root node. */
export async function parseC(source: string): Promise<SyntaxNode> {
  const parser = await getCParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse C source');
  return tree.rootNode;
}

/** Parse Ruby source and return root node. */
export async function parseRuby(source: string): Promise<SyntaxNode> {
  const parser = await getRubyParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Ruby source');
  return tree.rootNode;
}

/** Parse C# source and return root node. */
export async function parseCsharp(source: string): Promise<SyntaxNode> {
  const parser = await getCsharpParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse C# source');
  return tree.rootNode;
}

/** Parse Kotlin source and return root node. */
export async function parseKotlin(source: string): Promise<SyntaxNode> {
  const parser = await getKotlinParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Kotlin source');
  return tree.rootNode;
}

/** Parse Swift source and return root node. */
export async function parseSwift(source: string): Promise<SyntaxNode> {
  const parser = await getSwiftParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Swift source');
  return tree.rootNode;
}
