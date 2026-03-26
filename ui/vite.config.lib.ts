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
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'path';

/**
 * Rollup plugin that wraps all emitted CSS assets in `@layer opentrace { … }`.
 *
 * This prevents Tailwind (in consuming apps) from rewriting `color-mix()` rules
 * with `@supports` fallbacks that produce opaque backgrounds instead of the
 * intended translucent ones.  Layered CSS also ensures library styles never
 * accidentally override consumer styles.
 */
function cssLayerPlugin(): Plugin {
  return {
    name: 'opentrace-css-layer',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.css') && chunk.type === 'asset') {
          const css =
            typeof chunk.source === 'string'
              ? chunk.source
              : new TextDecoder().decode(chunk.source);
          // Pull @import rules out of the layer block — CSS requires
          // @import to appear before any other rules, including @layer.
          const imports: string[] = [];
          const rest = css.replace(/@import\s+url\([^)]*\)\s*;?/g, (m) => {
            imports.push(m.trimEnd().replace(/;?$/, ';'));
            return '';
          });
          chunk.source =
            (imports.length ? imports.join('\n') + '\n' : '') +
            `@layer opentrace {\n${rest}\n}\n`;
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), cssLayerPlugin()],
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
