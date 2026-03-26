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

import type { ImageAttachment } from '../components/chat/types';

const MAX_DIMENSION = 2048;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
export const MAX_IMAGES_PER_MESSAGE = 5;
const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function resizeImage(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
        resolve(dataUrl);
        return;
      }
      const scale = MAX_DIMENSION / Math.max(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

export async function processImageFiles(
  files: File[],
): Promise<{ images: ImageAttachment[]; errors: string[] }> {
  const images: ImageAttachment[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      errors.push(
        `"${file.name}" is not a supported format. Use PNG, JPEG, WebP, or GIF.`,
      );
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      errors.push(`"${file.name}" exceeds the 20 MB size limit.`);
      continue;
    }
    try {
      const raw = await fileToDataUrl(file);
      const dataUrl = await resizeImage(raw);
      images.push({
        id: crypto.randomUUID(),
        dataUrl,
        mimeType: file.type,
        name: file.name,
      });
    } catch {
      errors.push(`Failed to process "${file.name}".`);
    }
  }

  return { images, errors };
}

export function clipboardToImageFiles(e: ClipboardEvent): File[] {
  const files: File[] = [];
  if (!e.clipboardData) return files;
  for (let i = 0; i < e.clipboardData.items.length; i++) {
    const item = e.clipboardData.items[i];
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

export function dropToImageFiles(e: DragEvent): File[] {
  const files: File[] = [];
  if (!e.dataTransfer) return files;
  for (let i = 0; i < e.dataTransfer.files.length; i++) {
    const file = e.dataTransfer.files[i];
    if (file.type.startsWith('image/')) {
      files.push(file);
    }
  }
  return files;
}
