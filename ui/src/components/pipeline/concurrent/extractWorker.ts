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
 * Extract worker — parses a file with tree-sitter and walks the AST to
 * produce symbols + import analysis, entirely OFF the main thread. Only
 * serializable data crosses back (no AST nodes). The main thread merges the
 * results into the shared registries (see mergeExtraction in stages.ts).
 *
 * This is what lets huge repos (Grafana-scale) index fast without the parser
 * fighting the UI / live build for the main thread. Each worker owns its own
 * tree-sitter instance + grammar set (WASM can't be shared across workers).
 */

import { analyzeImports } from '../parser/importAnalyzer';
import { detectLanguage, getExtension } from '../stages/loading';
import {
  getExtractor,
  getParserForLanguage,
  initParsers,
} from '../stages/parsing';
import { buildParserMap } from '../stages/parserWasm';
import type { ExtractWorkerIn, ExtractWorkerOut } from './extractTypes';

const ctx = self as unknown as Worker;

let knownPaths = new Set<string>();
let goModulePath: string | undefined;

function post(msg: ExtractWorkerOut): void {
  ctx.postMessage(msg);
}

async function init(
  kp: Set<string>,
  gmp: string | undefined,
  parserKeys: string[] | undefined,
): Promise<void> {
  knownPaths = kp;
  goModulePath = gmp;
  const map = await buildParserMap(parserKeys);
  initParsers(map);
  post({ type: 'ready' });
}

ctx.onmessage = (ev: MessageEvent<ExtractWorkerIn>) => {
  const msg = ev.data;

  if (msg.type === 'init') {
    void init(msg.knownPaths, msg.goModulePath, msg.parserKeys);
    return;
  }

  // msg.type === 'extract'
  const { jobId, fileId, filePath, content } = msg;
  try {
    const ext = getExtension(filePath);
    const language = detectLanguage(ext);
    if (!language) {
      post({ type: 'skip', jobId, fileId });
      return;
    }

    const parser = getParserForLanguage(language, ext);
    const extractor = getExtractor(language);
    if (!parser || !extractor) {
      post({ type: 'skip', jobId, fileId });
      return;
    }

    const tree = parser.parse(content);
    if (!tree) {
      post({ type: 'skip', jobId, fileId });
      return;
    }

    try {
      const extraction = extractor(tree.rootNode);
      const importResult = analyzeImports(
        tree.rootNode,
        language,
        filePath,
        knownPaths,
        goModulePath,
      );
      post({
        type: 'result',
        jobId,
        fileId,
        language,
        symbols: extraction.symbols,
        importResult,
      });
    } finally {
      // Free the WASM-backed tree immediately — a worker processes thousands
      // of files, so relying on GC would balloon the WASM heap.
      tree.delete();
    }
  } catch (err) {
    post({
      type: 'error',
      jobId,
      fileId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
