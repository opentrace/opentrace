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

import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import {
  existsSync,
  readFileSync,
  createReadStream,
  readdirSync,
  copyFileSync,
  mkdirSync,
} from 'fs';
import { execSync } from 'child_process';
import { resolve, join } from 'path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {
  // not in a git repo
}

/**
 * Resolve the env directory — normally `..` (repo root), but when running
 * inside a git worktree the .env file lives in the main working tree since
 * it's gitignored. Fall back to the main tree root when the local one has
 * no .env file.
 */
function resolveEnvDir(): string {
  const localRoot = resolve(__dirname, '..');
  if (existsSync(resolve(localRoot, '.env'))) return localRoot;

  try {
    // `git worktree list --porcelain` lists the main working tree first.
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      cwd: __dirname,
    });
    const firstWorktree = output
      .split('\n')
      .find((line) => line.startsWith('worktree '));
    if (firstWorktree) {
      const mainRoot = firstWorktree.replace('worktree ', '');
      if (existsSync(resolve(mainRoot, '.env'))) return mainRoot;
    }
  } catch {
    // not in a git repo or git not available
  }

  return localRoot;
}

/**
 * Inline Vite plugin that sets Cross-Origin-Opener-Policy and
 * Cross-Origin-Embedder-Policy headers so SharedArrayBuffer is
 * available (required by lbug-wasm).
 *
 * Also sets the correct MIME type for .wasm files so WebAssembly
 * streaming compilation works (requires application/wasm).
 *
 * Uses "credentialless" instead of "require-corp" so cross-origin
 * fetches (e.g. api.github.com) still work without CORS attributes.
 */
function crossOriginIsolation(): Plugin {
  const publicDir = resolve(__dirname, 'public');
  const componentsWasmDir = resolve(__dirname, '../components/public/wasm');

  function wasmMiddleware(
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
    next: () => void,
  ) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

    // Serve .wasm files directly with correct MIME type.
    // Vite's static handler sets the wrong Content-Type for .wasm and
    // completes the response without calling next(), so no downstream
    // middleware can fix it. We serve them ourselves first.
    //
    // Check ui/public/ first (local overrides), then components/public/wasm/
    // (canonical location for tree-sitter grammars).
    const url = req.url?.split('?')[0];
    if (url?.endsWith('.wasm')) {
      const localPath = join(publicDir, url);
      const componentPath = join(componentsWasmDir, url.split('/').pop()!);
      const filePath = existsSync(localPath) ? localPath : componentPath;
      if (existsSync(filePath)) {
        res.setHeader('Content-Type', 'application/wasm');
        res.statusCode = 200;
        createReadStream(filePath).pipe(res);
        return;
      }
    }

    next();
  }

  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use(wasmMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(wasmMiddleware);
    },
  };
}

/**
 * Vite plugin that copies tree-sitter WASM files from components/public/wasm/
 * into the build output. During dev, the crossOriginIsolation middleware serves
 * them directly; this plugin handles production builds.
 */
function copyComponentsWasm(): Plugin {
  const wasmDir = resolve(__dirname, '../components/public/wasm');
  return {
    name: 'copy-components-wasm',
    writeBundle(options) {
      if (!existsSync(wasmDir)) return;
      const outDir = options.dir || resolve(__dirname, 'dist');
      mkdirSync(outDir, { recursive: true });
      for (const file of readdirSync(wasmDir)) {
        if (!file.endsWith('.wasm')) continue;
        // Don't overwrite files already in ui/public/ (copied by Vite)
        const dest = join(outDir, file);
        if (!existsSync(dest)) {
          copyFileSync(join(wasmDir, file), dest);
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = resolveEnvDir();
  const env = loadEnv(mode, envDir, '');
  const port =
    Number(process.env.PORT) ||
    Number(process.env.VITE_PORT) ||
    Number(env.VITE_PORT) ||
    5173;

  return {
    envDir,
    define: {
      __APP_VERSION__: JSON.stringify(`${pkg.version}+${gitSha}`),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    resolve: {
      alias: {
        // Resolve through source so Vite processes workers & CSS correctly.
        // Without this, production builds pick up the pre-built dist bundle
        // which has baked-in worker URLs that Rollup can't resolve.
        '@opentrace/components/pipeline': resolve(
          __dirname,
          '../components/src/pipeline/index.ts',
        ),
        '@opentrace/components/utils': resolve(
          __dirname,
          '../components/src/utils.ts',
        ),
        '@opentrace/components': resolve(
          __dirname,
          '../components/src/index.ts',
        ),
      },
      dedupe: ['react', 'react-dom'],
    },
    plugins: [react(), crossOriginIsolation(), copyComponentsWasm()],
    build: {
      sourcemap: true,
    },
    server: {
      port,
      strictPort: true,
      fs: {
        allow: [resolve(__dirname), resolve(__dirname, '../components')],
      },
    },
    optimizeDeps: {
      exclude: ['web-tree-sitter', '@lbug/lbug-wasm'],
    },
    worker: {
      format: 'es',
    },
  };
});
