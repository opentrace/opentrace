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
 * Shared machinery for the component-scoped CSS bundles published alongside the
 * batteries-included `dist/lib/opentrace.css` (`./style.css`).
 *
 * Each bundle concatenates a set of co-located, token-driven component
 * stylesheets into a single `@layer opentrace`-wrapped file carrying one
 * generated header. Callers differ only in WHICH sources they pull in (a glob
 * of a directory, or an explicit file list), the output path, and the header
 * text — everything else (license strip, indent, layer wrap, mkdir/write) is
 * common and lives here so a fix to e.g. the strip regex or the cascade-layer
 * wrapping is made in exactly one place.
 *
 * Used by build-graph-css.mjs and build-detail-panels-css.mjs.
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Strip the leading Apache license block comment so the generated file carries
// a single header rather than one per source file.
export function stripLicenseHeader(css) {
  return css.replace(
    /^\s*\/\*[\s\S]*?Copyright \d{4} OpenTrace Contributors[\s\S]*?\*\/\s*/,
    '',
  );
}

// Indent every non-empty line one level, for nesting inside @layer { … }.
export function indent(css) {
  return css
    .split('\n')
    .map((line) => (line.length ? `  ${line}` : line))
    .join('\n');
}

/**
 * Resolve the ordered, absolute list of source stylesheet paths.
 *
 * Pass `files` for an explicit, curated list (relative to `srcDir`) — use this
 * when the source directory also holds CSS that must NOT be bundled. Pass
 * `glob: true` to sweep every `*.css` in `srcDir` — use this when any new
 * sibling stylesheet should flow in automatically. Exactly one must be given.
 */
function resolveSources({ srcDir, files, glob }) {
  if (files && glob) {
    throw new Error('[bundle-css] pass either `files` or `glob`, not both');
  }
  if (files) {
    const missing = files.filter((f) => !existsSync(join(srcDir, f)));
    if (missing.length > 0) {
      throw new Error(
        `[bundle-css] missing source stylesheet(s): ${missing.join(', ')}`,
      );
    }
    return files.map((f) => join(srcDir, f));
  }
  if (glob) {
    if (!existsSync(srcDir)) {
      throw new Error(`[bundle-css] missing source dir: ${srcDir}`);
    }
    const found = readdirSync(srcDir)
      .filter((f) => f.endsWith('.css'))
      .sort();
    if (found.length === 0) {
      throw new Error(`[bundle-css] no .css files found in ${srcDir}`);
    }
    return found.map((f) => join(srcDir, f));
  }
  throw new Error('[bundle-css] pass either `files` or `glob`');
}

/**
 * Concatenate `sources` (see resolveSources) into `@layer opentrace { … }`,
 * prefix `header`, and write to `outFile`. `tag` labels the console log line.
 * Returns the ordered basenames that were bundled.
 */
export function bundleCss({ srcDir, files, glob, outFile, header, tag }) {
  const sources = resolveSources({ srcDir, files, glob });

  const sections = sources.map((path) => {
    const name = basename(path);
    const css = stripLicenseHeader(readFileSync(path, 'utf-8'));
    return `  /* ── ${name} ─────────────────────────────── */\n${indent(css.trim())}\n`;
  });

  const body = `@layer opentrace {\n${sections.join('\n')}}\n`;

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${header}\n${body}`, 'utf-8');

  const names = sources.map((p) => basename(p));
  console.log(
    `[${tag}] wrote ${outFile} from ${names.length} stylesheet(s): ${names.join(', ')}`,
  );
  return names;
}
