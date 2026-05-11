#!/usr/bin/env node

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
 * Copy tree-sitter WASM files to your app's public directory.
 *
 * Usage:
 *   npx opentrace-copy-wasm <dest-dir>
 *   npx opentrace-copy-wasm public/
 *   npx opentrace-copy-wasm --languages python,typescript,go public/
 *
 * Options:
 *   --languages <list>  Comma-separated list of languages to copy (default: all)
 *   --runtime-only      Copy only the web-tree-sitter runtime WASM
 *   --help              Show this help message
 */

import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WASM_DIR = join(__dirname, '..', 'public', 'wasm');

function printUsage() {
  console.log(`Usage: opentrace-copy-wasm [options] <dest-dir>

Copy tree-sitter WASM files to your app's public directory so they can
be served as static assets for browser-based code parsing.

Options:
  --languages <list>  Comma-separated list of languages (default: all)
                      Available: python, typescript, tsx, go, rust, java,
                      kotlin, ruby, c, cpp, csharp, swift, php, bash, json,
                      toml
  --runtime-only      Copy only the web-tree-sitter.wasm runtime
  --help              Show this help message

Examples:
  opentrace-copy-wasm public/
  opentrace-copy-wasm --languages python,typescript,go public/
  opentrace-copy-wasm --runtime-only public/`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(args.includes('--help') ? 0 : 1);
  }

  let languages = null;
  let runtimeOnly = false;
  let destDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--languages' && i + 1 < args.length) {
      languages = new Set(args[++i].split(',').map((s) => s.trim()));
    } else if (args[i] === '--runtime-only') {
      runtimeOnly = true;
    } else if (!args[i].startsWith('-')) {
      destDir = args[i];
    }
  }

  if (!destDir) {
    console.error('Error: destination directory is required');
    printUsage();
    process.exit(1);
  }

  const dest = resolve(destDir);
  await mkdir(dest, { recursive: true });

  const files = await readdir(WASM_DIR);
  let copied = 0;

  for (const file of files) {
    if (!file.endsWith('.wasm')) continue;

    // Always copy the runtime
    if (file === 'web-tree-sitter.wasm') {
      await copyFile(join(WASM_DIR, file), join(dest, file));
      copied++;
      continue;
    }

    if (runtimeOnly) continue;

    // Filter by language if specified
    if (languages) {
      const lang = file
        .replace('tree-sitter-', '')
        .replace('.wasm', '')
        .replace('c_sharp', 'csharp');
      if (!languages.has(lang)) continue;
    }

    await copyFile(join(WASM_DIR, file), join(dest, file));
    copied++;
  }

  console.log(
    `Copied ${copied} WASM file${copied !== 1 ? 's' : ''} to ${dest}`,
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
