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
 * Helpers for locating tree-sitter WASM files shipped with this package.
 *
 * Usage (Node.js — tests, build scripts, CLI tools):
 *
 *   import { getWasmDir, getWasmPath } from '@opentrace/components/pipeline';
 *
 *   // Directory containing all WASM files
 *   const dir = getWasmDir();
 *
 *   // Path to a specific grammar
 *   const pyWasm = getWasmPath('python');
 *   const lang = await Language.load(await readFile(pyWasm));
 *
 * Usage (browser — Vite/webpack/etc.):
 *
 *   WASM files must be copied to your app's public directory so they're
 *   served as static assets. Use the included CLI:
 *
 *     npx opentrace-copy-wasm public/
 *
 *   Or in your package.json scripts:
 *
 *     "postinstall": "opentrace-copy-wasm public/"
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the WASM directory. Walks up from this file's location until
 * it finds a `public/wasm` directory. Works from both source and dist:
 *
 * - Source: components/src/pipeline/wasm.ts  (2 levels up)
 * - Dist:   components/dist/pipeline.js      (1 level up)
 * - npm:    @opentrace/components/dist/pipeline.js (1 level up)
 */
function findWasmDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'public', 'wasm');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  // Should not happen in a correctly installed package
  throw new Error(
    'Could not find WASM directory. Ensure @opentrace/components is installed correctly.',
  );
}

let _wasmDir: string | undefined;

/** Language key → WASM filename mapping. */
const WASM_FILES: Record<string, string> = {
  bash: 'tree-sitter-bash.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  json: 'tree-sitter-json.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  php: 'tree-sitter-php.wasm',
  python: 'tree-sitter-python.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  rust: 'tree-sitter-rust.wasm',
  swift: 'tree-sitter-swift.wasm',
  toml: 'tree-sitter-toml.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  typescript: 'tree-sitter-typescript.wasm',
};

/** All supported language keys. */
export const SUPPORTED_LANGUAGES = Object.keys(WASM_FILES);

/** Get the absolute path to the directory containing all WASM files. */
export function getWasmDir(): string {
  if (!_wasmDir) _wasmDir = findWasmDir();
  return _wasmDir;
}

/**
 * Get the absolute path to a specific WASM file.
 *
 * @param key - Language key (e.g. 'python', 'typescript', 'tsx') or
 *              'runtime' for the web-tree-sitter runtime WASM.
 * @returns Absolute path to the .wasm file.
 * @throws If the language key is not recognized.
 */
export function getWasmPath(key: string): string {
  if (key === 'runtime') {
    return join(getWasmDir(), 'web-tree-sitter.wasm');
  }
  const file = WASM_FILES[key];
  if (!file) {
    throw new Error(
      `Unknown language "${key}". Supported: ${SUPPORTED_LANGUAGES.join(', ')}, runtime`,
    );
  }
  return join(getWasmDir(), file);
}
