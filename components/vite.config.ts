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
 * Vite config for building @opentrace/components as a library.
 *
 * Outputs:
 *   dist/opentrace-components.js   (ESM)
 *   dist/opentrace-components.cjs  (CJS)
 *   dist/components.css            (extracted CSS)
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'dist',
    lib: {
      entry: {
        'opentrace-components': resolve(__dirname, 'src/index.ts'),
        utils: resolve(__dirname, 'src/utils.ts'),
        indexing: resolve(__dirname, 'src/indexing/index.ts'),
        pipeline: resolve(__dirname, 'src/pipeline/index.ts'),
        'pipeline-wasm': resolve(__dirname, 'src/pipeline/wasm.ts'),
        chat: resolve(__dirname, 'src/chat/index.ts'),
      },
      name: 'OpenTraceComponents',
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'web-tree-sitter',
        'node:fs',
        'node:path',
        'node:url',
        // Chat dependencies — externalized as peer deps
        '@langchain/core',
        '@langchain/core/messages',
        'react-markdown',
        'remark-gfm',
        'mermaid',
      ],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
      },
    },
    sourcemap: true,
    minify: false,
  },
  worker: {
    format: 'es',
  },
});
