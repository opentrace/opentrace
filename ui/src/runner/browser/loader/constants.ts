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
 * Constants for directory/file filtering during indexing.
 * Ported from agent/src/opentrace_agent/sources/code/directory_walker.py
 */

export const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
  'dist',
  'build',
  '.idea',
  '.vscode',
  '.mypy_cache',
  '.ruff_cache',
  '.pytest_cache',
  '.tox',
  '.eggs',
  'egg-info',
]);

export const INCLUDED_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.swift',
  '.php',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
  '.md',
  '.proto',
  '.graphql',
  '.sql',
  '.sh',
  '.bash',
  '.dockerfile',
  '.tf',
  '.hcl',
]);

export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.rb': 'ruby',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.sql': 'sql',
};

/** Languages we have tree-sitter WASM parsers for. */
export const PARSEABLE_LANGUAGES = new Set([
  'python',
  'typescript',
  'go',
  'javascript',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'c',
  'cpp',
  'ruby',
  'swift',
  'php',
]);

/** File extensions that map to a parseable language (i.e. can contain symbols). */
export const PARSEABLE_EXTENSIONS = new Set(
  Object.entries(EXTENSION_LANGUAGE_MAP)
    .filter(([, lang]) => PARSEABLE_LANGUAGES.has(lang))
    .map(([ext]) => ext),
);

/** Image file extensions recognized for binary handling. */
export const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
]);

/** Map image extensions → MIME types (used for data-URI rendering). */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/**
 * Known binary file extensions that should never be decoded as text.
 * Used as a fast-path skip before content-based heuristics.
 */
export const BINARY_EXTENSIONS = new Set([
  // Archives & packages
  '.jar',
  '.war',
  '.ear',
  '.zip',
  '.gz',
  '.tar',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.zst',
  '.tgz',
  // Compiled / executables
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.out',
  '.elf',
  '.class',
  '.pyc',
  '.pyo',
  '.o',
  '.obj',
  '.a',
  '.lib',
  // WASM
  '.wasm',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // Media (non-image, handled separately)
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.flac',
  '.avi',
  '.mov',
  '.mkv',
  '.webm',
  // Data / DB
  '.sqlite',
  '.db',
  '.dat',
  '.pkl',
  '.parquet',
  '.arrow',
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  // Misc
  '.lock',
]);

/** Max file size (bytes) to attempt parsing. Files larger are skipped. */
export const MAX_FILE_SIZE = 1_000_000;

/**
 * Max archive size (bytes) for repository downloads.
 * Matches the UI's MiB-based display boundary: fires as soon as
 * `(bytes / 1024 / 1024).toFixed(1)` rounds to "500.0" MB.
 */
export const MAX_ARCHIVE_SIZE = Math.ceil(499.95 * 1024 * 1024);
