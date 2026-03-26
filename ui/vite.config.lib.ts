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
 * Usage:  npm run build:lib
 *
 * Outputs:
 *   dist/lib/opentrace-components.js   (ESM)
 *   dist/lib/opentrace-components.cjs  (CJS)
 *   dist/lib/components.css            (extracted CSS)
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), wasm()],
  publicDir: false,
  resolve: {
    alias: {
      '@opentrace/components/chat': resolve(
        __dirname,
        'src/components/chat/index.ts',
      ),
      '@opentrace/components/pipeline': resolve(
        __dirname,
        'src/components/pipeline/index.ts',
      ),
      '@opentrace/components/utils': resolve(
        __dirname,
        'src/components/utils.ts',
      ),
      '@opentrace/components': resolve(__dirname, 'src/components/index.ts'),
    },
  },
  build: {
    outDir: 'dist/lib',
    lib: {
      entry: {
        'opentrace-components': resolve(__dirname, 'src/components/index.ts'),
        utils: resolve(__dirname, 'src/components/utils.ts'),
        indexing: resolve(__dirname, 'src/components/indexing/index.ts'),
        pipeline: resolve(__dirname, 'src/components/pipeline/index.ts'),
        'pipeline-wasm': resolve(__dirname, 'src/components/pipeline/wasm.ts'),
        chat: resolve(__dirname, 'src/components/chat/index.ts'),
        app: resolve(__dirname, 'src/OpenTraceApp.tsx'),
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
        'react-markdown',
        'remark-gfm',
        'node:fs',
        'node:path',
        'node:url',
        // WASM packages use top-level await, incompatible with CJS output.
        // Consumers' bundlers resolve these from node_modules at build time.
        'parquet-wasm/bundler',
        '@ladybugdb/wasm-core',
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
