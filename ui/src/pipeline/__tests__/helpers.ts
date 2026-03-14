import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';
import type { RepoTree } from '../types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', '..', '..', 'public');

let initialized = false;

export async function initTreeSitter(): Promise<void> {
  if (initialized) return;
  const wasmBuf = await readFile(join(PUBLIC_DIR, 'web-tree-sitter.wasm'));
  await Parser.init({
    locateFile: () => join(PUBLIC_DIR, 'web-tree-sitter.wasm'),
    wasmBinary: wasmBuf,
  });
  initialized = true;
}

let pyParser: Parser | null = null;

export async function getPythonParser(): Promise<Parser> {
  await initTreeSitter();
  if (!pyParser) {
    pyParser = new Parser();
    const buf = await readFile(join(PUBLIC_DIR, 'tree-sitter-python.wasm'));
    const lang = await Language.load(buf);
    pyParser.setLanguage(lang);
  }
  return pyParser;
}

export async function parsePython(source: string): Promise<SyntaxNode> {
  const parser = await getPythonParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('Failed to parse Python source');
  return tree.rootNode;
}

export function makeRepoTree(
  files: Array<{ path: string; content?: string }>,
  opts?: {
    owner?: string;
    repo?: string;
    ref?: string;
    url?: string;
    provider?: string;
  },
): RepoTree {
  return {
    owner: opts?.owner ?? 'testorg',
    repo: opts?.repo ?? 'testrepo',
    ref: opts?.ref ?? 'main',
    url: opts?.url,
    provider: opts?.provider,
    files: files.map((f) => ({ path: f.path, content: f.content ?? '' })),
  };
}
