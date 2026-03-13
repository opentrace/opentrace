import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';

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
 * available (required by kuzu-wasm).
 *
 * Uses "credentialless" instead of "require-corp" so cross-origin
 * fetches (e.g. api.github.com) still work without CORS attributes.
 */
function crossOriginIsolation(): Plugin {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  envDir: resolveEnvDir(),
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version}+${gitSha}`),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [react(), crossOriginIsolation()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/fn': {
        target: 'http://localhost:5001/handy-amplifier-455315-e6/europe-west1',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['web-tree-sitter', '@kuzu/kuzu-wasm'],
  },
  worker: {
    format: 'es',
  },
});
