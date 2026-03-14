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
 * Check whether a port is available by attempting a synchronous bind.
 * Uses execSync to run a tiny Node one-liner so the check is blocking.
 */
function isPortFree(port: number): boolean {
  try {
    execSync(
      `node -e "const s=require('net').createServer();s.on('error',()=>process.exit(1));s.on('listening',()=>{s.close();process.exit(0)});s.listen(${port},'0.0.0.0')"`,
      { stdio: 'ignore', timeout: 2000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the first available port in the range 5173–5180. Returns
 * undefined when no port is free (Vite will then fall back to its
 * own default behaviour).
 */
function resolvePort(): number | undefined {
  for (let port = 5173; port <= 5180; port++) {
    if (isPortFree(port)) return port;
  }
  return undefined;
}

/**
 * Inline Vite plugin that sets Cross-Origin-Opener-Policy and
 * Cross-Origin-Embedder-Policy headers so SharedArrayBuffer is
 * available (required by kuzu-wasm).
 *
 * Also sets the correct MIME type for .wasm files so WebAssembly
 * streaming compilation works (requires application/wasm).
 *
 * Uses "credentialless" instead of "require-corp" so cross-origin
 * fetches (e.g. api.github.com) still work without CORS attributes.
 */
function crossOriginIsolation(): Plugin {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        if (req.url?.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        if (req.url?.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }
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
    port: resolvePort(),
    strictPort: true,
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
    exclude: ['web-tree-sitter', 'kuzu-wasm'],
  },
  worker: {
    format: 'es',
  },
});
