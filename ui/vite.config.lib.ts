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
 * Usage: vite build --config vite.config.lib.ts
 *
 * Outputs:
 *   dist/lib/opentrace-components.js   (ESM)
 *   dist/lib/opentrace-components.cjs  (CJS)
 *   dist/lib/style.css                 (extracted CSS)
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  // Don't copy public/ assets into the library output
  publicDir: false,
  build: {
    outDir: 'dist/lib',
    lib: {
      entry: resolve(__dirname, 'src/lib/index.ts'),
      name: 'OpenTraceComponents',
      formats: ['es', 'cjs'],
      fileName: (format) =>
        `opentrace-components.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      // Only externalize React — everything else is bundled
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime',
        },
      },
    },
    // Generate source maps for debugging
    sourcemap: true,
    // Don't minify — let consumers handle that
    minify: false,
  },
  worker: {
    format: 'es',
  },
});
