import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

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
  envDir: '..',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
