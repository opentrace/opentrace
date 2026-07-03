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
 * Export a chat conversation to Markdown or a self-contained HTML document.
 *
 * The HTML path reuses the app's own markdown engine (`react-markdown` +
 * `remark-gfm`) via `react-dom/server` so the rendered output matches what
 * the user sees in the chat — headings, lists, tables, code blocks, etc.
 */
import { createElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, AssistantMessage } from './types';

const USER_LABEL = '🧑 User';
const ASSISTANT_LABEL = '🤖 Assistant';

/** Build a readable Markdown body for a single message. */
function messageBodyMarkdown(m: ChatMessage): string {
  if (m.role === 'user') {
    const blocks: string[] = [];
    if (m.content.trim()) blocks.push(m.content.trim());
    const names = [
      ...(m.attachments ?? []).map((a) => a.name || a.kind),
      ...(m.images ?? []).map((i) => i.name || 'image'),
    ];
    if (names.length) blocks.push(`*Attachments: ${names.join(', ')}*`);
    return blocks.join('\n\n') || '_(no text)_';
  }

  // Assistant — assemble from structured parts so tool calls and reasoning
  // are preserved alongside the answer text.
  const blocks: string[] = [];
  for (const part of (m as AssistantMessage).parts) {
    if (part.type === 'text') {
      if (part.content.trim()) blocks.push(part.content.trim());
    } else if (part.type === 'thought') {
      const t = part.content.trim();
      if (t) {
        blocks.push(
          t
            .split('\n')
            .map((line) => `> 💭 ${line}`)
            .join('\n'),
        );
      }
    } else if (part.type === 'tool_call') {
      blocks.push(`> 🔧 **${part.name}**`);
    }
  }
  // Fall back to the flattened content if parts produced nothing renderable.
  if (!blocks.length && (m as AssistantMessage).content.trim()) {
    blocks.push((m as AssistantMessage).content.trim());
  }
  return blocks.join('\n\n') || '_(no content)_';
}

/** Serialize the whole conversation to a Markdown document. */
export function conversationToMarkdown(
  messages: ChatMessage[],
  title: string,
  exportedAt: Date = new Date(),
): string {
  const out: string[] = [
    `# ${title}`,
    '',
    `*Exported ${exportedAt.toLocaleString()}*`,
    '',
  ];
  for (const m of messages) {
    out.push(`## ${m.role === 'user' ? USER_LABEL : ASSISTANT_LABEL}`, '');
    out.push(messageBodyMarkdown(m), '');
  }
  return out.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const HTML_STYLES = `
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6; margin: 0; padding: 2rem 1rem;
    background: #f6f7f9; color: #1a1a1a;
  }
  .conversation { max-width: 820px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
  .meta { color: #6b7280; font-size: 0.85rem; margin: 0 0 2rem; }
  .msg { margin: 0 0 1.25rem; padding: 1rem 1.25rem; border-radius: 10px;
    background: #fff; border: 1px solid #e5e7eb; }
  .msg.user { border-left: 3px solid #3b82f6; }
  .msg.assistant { border-left: 3px solid #10b981; }
  .role { font-weight: 600; font-size: 0.8rem; text-transform: uppercase;
    letter-spacing: 0.04em; color: #6b7280; margin-bottom: 0.5rem; }
  .body > :first-child { margin-top: 0; }
  .body > :last-child { margin-bottom: 0; }
  pre { background: #0f172a; color: #e2e8f0; padding: 0.85rem 1rem;
    border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  :not(pre) > code { background: #eef0f3; padding: 0.1em 0.35em; border-radius: 4px;
    font-size: 0.9em; }
  blockquote { margin: 0.5rem 0; padding: 0.25rem 0 0.25rem 0.9rem;
    border-left: 3px solid #d1d5db; color: #4b5563; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #e5e7eb; padding: 0.4rem 0.6rem; text-align: left; }
  a { color: #2563eb; }
  @media (prefers-color-scheme: dark) {
    body { background: #0b0f17; color: #e5e7eb; }
    .msg { background: #131a26; border-color: #1f2937; }
    .meta, .role { color: #94a3b8; }
    :not(pre) > code { background: #1f2937; }
    th, td { border-color: #1f2937; }
  }
`;

/**
 * Serialize the conversation to a standalone HTML document with the
 * markdown rendered to real HTML (reusing the app's markdown engine).
 */
export async function conversationToHtml(
  messages: ChatMessage[],
  title: string,
  exportedAt: Date = new Date(),
): Promise<string> {
  // Lazy-load the server renderer so it isn't in the main bundle.
  const { renderToStaticMarkup } = await import('react-dom/server');
  const renderMarkdown = (md: string): string =>
    renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md),
    );

  const sections = messages
    .map((m) => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      const label = m.role === 'user' ? USER_LABEL : ASSISTANT_LABEL;
      const body = renderMarkdown(messageBodyMarkdown(m));
      return `    <section class="msg ${role}">\n      <div class="role">${label}</div>\n      <div class="body">${body}</div>\n    </section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${HTML_STYLES}</style>
</head>
<body>
  <div class="conversation">
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">Exported ${escapeHtml(exportedAt.toLocaleString())}</p>
${sections}
  </div>
</body>
</html>
`;
}

/** Slug suitable for a download filename (no extension). */
export function conversationFilenameBase(
  title: string,
  exportedAt: Date = new Date(),
): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation';
  const y = exportedAt.getFullYear();
  const mo = String(exportedAt.getMonth() + 1).padStart(2, '0');
  const d = String(exportedAt.getDate()).padStart(2, '0');
  return `chat-${slug}-${y}${mo}${d}`;
}

/** Trigger a browser download of text content. */
export function downloadTextFile(
  filename: string,
  content: string,
  mime: string,
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
