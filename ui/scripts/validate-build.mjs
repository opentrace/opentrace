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
 * Post-build smoke test — validates the Vite build output is usable.
 *
 * Checks:
 * 1. dist/index.html exists and references script/style assets
 * 2. All referenced assets exist on disk with non-zero size
 * 3. At least one .js and one .css file in dist/assets/
 * 4. WASM files present in dist/wasm/
 * 5. No JS bundle exceeds 5 MB (catches accidental bundling regressions)
 *
 * Usage: node scripts/validate-build.mjs
 */

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DIST = resolve(__dirname, '..', 'dist');
const MAX_BUNDLE_SIZE = 5 * 1024 * 1024; // 5 MB

const errors = [];

function fail(msg) {
  errors.push(msg);
}

function checkFile(path, label) {
  if (!existsSync(path)) {
    fail(`Missing: ${label} (${path})`);
    return null;
  }
  const stat = statSync(path);
  if (stat.size === 0) {
    fail(`Empty file: ${label} (${path})`);
    return null;
  }
  return stat;
}

// 1. dist/index.html exists and has content
const indexPath = join(DIST, 'index.html');
const indexStat = checkFile(indexPath, 'dist/index.html');

if (indexStat) {
  const html = readFileSync(indexPath, 'utf-8');

  // Extract asset references from script and link tags
  const scriptRefs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  const styleRefs = [...html.matchAll(/href="([^"]+\.css[^"]*)"/g)].map(
    (m) => m[1],
  );
  const assetRefs = [...scriptRefs, ...styleRefs];

  if (assetRefs.length === 0) {
    fail('index.html contains no script or stylesheet references');
  }

  // 2. Each referenced asset exists on disk
  for (const ref of assetRefs) {
    // Skip data URIs (inlined assets) and external URLs
    if (
      ref.startsWith('data:') ||
      ref.startsWith('http://') ||
      ref.startsWith('https://')
    ) {
      continue;
    }
    // Strip leading slash for file path resolution
    const assetPath = join(DIST, ref.replace(/^\//, ''));
    checkFile(assetPath, `Referenced asset: ${ref}`);
  }
}

// 3. At least one .js and one .css in dist/assets/
const assetsDir = join(DIST, 'assets');
if (existsSync(assetsDir)) {
  const files = readdirSync(assetsDir);
  const hasJS = files.some((f) => f.endsWith('.js'));
  const hasCSS = files.some((f) => f.endsWith('.css'));
  if (!hasJS) fail('No .js files found in dist/assets/');
  if (!hasCSS) fail('No .css files found in dist/assets/');

  // 5. Check bundle sizes
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const filePath = join(assetsDir, f);
    const stat = statSync(filePath);
    if (stat.size > MAX_BUNDLE_SIZE) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
      fail(
        `Bundle too large: ${f} is ${sizeMB} MB (max ${MAX_BUNDLE_SIZE / 1024 / 1024} MB)`,
      );
    }
  }
} else {
  fail('dist/assets/ directory does not exist');
}

// 4. WASM files present (Vite copies public/ to dist/)
const wasmDir = join(DIST, 'wasm');
if (existsSync(wasmDir)) {
  const wasmFiles = readdirSync(wasmDir).filter((f) => f.endsWith('.wasm'));
  if (wasmFiles.length === 0) {
    fail('No .wasm files found in dist/wasm/');
  }
  // web-tree-sitter.wasm is required for the indexer
  const coreWasm = join(wasmDir, 'web-tree-sitter.wasm');
  checkFile(coreWasm, 'web-tree-sitter.wasm');
} else {
  fail('dist/wasm/ directory does not exist');
}

// Report
if (errors.length > 0) {
  console.error('\n❌ Build validation failed:\n');
  for (const e of errors) {
    console.error(`  • ${e}`);
  }
  console.error('');
  process.exit(1);
} else {
  console.log('✅ Build validation passed');
}
