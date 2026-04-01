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

import type {
  Attachment,
  ImageAttachment,
  FileAttachment,
} from '../components/chat/types';

const MAX_DIMENSION = 2048;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const MAX_TEXT_FILE_SIZE = 1 * 1024 * 1024; // 1 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
];

/** Extensions treated as text even when the browser gives a generic MIME type */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.kts',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.rb',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.sql',
  '.graphql',
  '.gql',
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
  '.proto',
  '.tf',
  '.hcl',
  '.dockerfile',
  '.gitignore',
  '.editorconfig',
  '.eslintrc',
  '.prettierrc',
]);

function isImageFile(file: File): boolean {
  return IMAGE_MIME_TYPES.includes(file.type);
}

function isTextFile(file: File): boolean {
  if (TEXT_MIME_TYPES.includes(file.type)) return true;
  if (file.type === '' || file.type === 'application/octet-stream') {
    const ext = getExtension(file.name);
    return TEXT_EXTENSIONS.has(ext);
  }
  const ext = getExtension(file.name);
  return TEXT_EXTENSIONS.has(ext);
}

function getExtension(name: string): string {
  // Handle dotfiles like .gitignore, .env
  const basename = name.split('/').pop() || name;
  if (basename.startsWith('.') && !basename.includes('.', 1)) {
    return basename.toLowerCase();
  }
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

export function isSupportedFile(file: File): boolean {
  return isImageFile(file) || isTextFile(file);
}

// ── Image processing (unchanged from imageUtils.ts) ──

function loadImage(
  file: File,
): Promise<{ img: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

function canvasToDataUrl(
  img: HTMLImageElement,
  width: number,
  height: number,
  mimeType: string,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(img, 0, 0, width, height);
  const hasAlpha = mimeType !== 'image/jpeg';
  const outputType = hasAlpha ? 'image/webp' : 'image/jpeg';
  return canvas.toDataURL(outputType, 0.85);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

async function processImage(file: File): Promise<string> {
  const { img, url } = await loadImage(file);
  try {
    const { width, height } = img;
    if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
      return await fileToDataUrl(file);
    }
    const scale = MAX_DIMENSION / Math.max(width, height);
    return canvasToDataUrl(
      img,
      Math.round(width * scale),
      Math.round(height * scale),
      file.type,
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Text file processing ──

function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// ── Unified processing ──

export async function processFiles(
  files: File[],
): Promise<{ attachments: Attachment[]; errors: string[] }> {
  const attachments: Attachment[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (isImageFile(file)) {
      if (file.size > MAX_IMAGE_SIZE) {
        errors.push(`"${file.name}" exceeds the 20 MB size limit.`);
        continue;
      }
      try {
        const dataUrl = await processImage(file);
        attachments.push({
          kind: 'image',
          id: crypto.randomUUID(),
          dataUrl,
          mimeType: file.type,
          name: file.name,
        } satisfies ImageAttachment);
      } catch {
        errors.push(`Failed to process "${file.name}".`);
      }
    } else if (isTextFile(file)) {
      if (file.size > MAX_TEXT_FILE_SIZE) {
        errors.push(`"${file.name}" exceeds the 1 MB text file size limit.`);
        continue;
      }
      try {
        const textContent = await readTextFile(file);
        attachments.push({
          kind: 'file',
          id: crypto.randomUUID(),
          textContent,
          mimeType: file.type || 'text/plain',
          name: file.name,
        } satisfies FileAttachment);
      } catch {
        errors.push(`Failed to read "${file.name}".`);
      }
    } else {
      const ext = getExtension(file.name);
      errors.push(
        `"${file.name}" is not a supported format.${ext ? ` (${ext})` : ''} Use images or text files.`,
      );
    }
  }

  return { attachments, errors };
}

/** Extract files from a clipboard paste event */
export function clipboardToFiles(e: ClipboardEvent): File[] {
  const files: File[] = [];
  if (!e.clipboardData) return files;
  for (let i = 0; i < e.clipboardData.items.length; i++) {
    const item = e.clipboardData.items[i];
    const file = item.getAsFile();
    if (file && (isImageFile(file) || isTextFile(file))) {
      files.push(file);
    }
  }
  return files;
}

/** Extract files from a drag-drop event */
export function dropToFiles(e: DragEvent): File[] {
  const files: File[] = [];
  if (!e.dataTransfer) return files;
  for (let i = 0; i < e.dataTransfer.files.length; i++) {
    const file = e.dataTransfer.files[i];
    if (isImageFile(file) || isTextFile(file)) {
      files.push(file);
    }
  }
  return files;
}
