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
 * Shared tree-sitter grammar loading. Used by BOTH the main thread
 * (browserJobService, for small repos / fallback) and the extract worker
 * pool (for large repos) so grammars are loaded from a single source of
 * truth — no drift between the two parse paths.
 */

import { Parser, Language } from 'web-tree-sitter';
import type { ParserMap } from '../types';

/** Map of parser key → WASM filename for all supported languages. */
export const PARSER_WASM_MAP: Record<string, string> = {
  python: 'tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-tsx.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  swift: 'tree-sitter-swift.wasm',
  php: 'tree-sitter-php.wasm',
};

let coreReady = false;

/** Initialize the tree-sitter core WASM (idempotent per JS context). */
export async function ensureTreeSitterCore(): Promise<void> {
  if (coreReady) return;
  await Parser.init({ locateFile: (file: string) => `/${file}` });
  coreReady = true;
}

/**
 * Build a ParserMap by loading the requested grammars (all of them when
 * `keys` is omitted). Grammars that fail to load are skipped with a warning
 * rather than aborting — the rest of the languages still work.
 */
export async function buildParserMap(
  keys?: Iterable<string>,
): Promise<ParserMap> {
  await ensureTreeSitterCore();

  const wanted = keys ? new Set(keys) : null;
  const entries = Object.entries(PARSER_WASM_MAP).filter(
    ([key]) => !wanted || wanted.has(key),
  );

  const map: ParserMap = new Map();
  const results = await Promise.allSettled(
    entries.map(async ([key, wasmFile]) => {
      const parser = new Parser();
      const lang = await Language.load(`/${wasmFile}`);
      parser.setLanguage(lang);
      return { key, parser };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const [key, wasmFile] = entries[i];
    if (result.status === 'fulfilled') {
      map.set(result.value.key, result.value.parser);
    } else {
      console.warn(
        `[buildParserMap] ${key} (${wasmFile}) failed:`,
        result.reason,
      );
    }
  }

  return map;
}
