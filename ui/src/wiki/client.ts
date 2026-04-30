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
 * REST client for the wiki/vault endpoints exposed by `opentraceai serve`.
 *
 * The vault feature requires a backend server — the UI cannot compile a
 * vault locally because it needs LLM access + disk writes. If no server
 * URL is configured, the client falls back to `http://localhost:8787`
 * (the agent's default bind).
 */

import type { VaultDetail, WikiCompileEvent } from './types';

const DEFAULT_BASE = 'http://localhost:8787';

export function getVaultApiBase(): string {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get('server');
    if (fromQuery) return fromQuery.replace(/\/+$/, '');
  } catch {
    /* ignore */
  }
  return DEFAULT_BASE;
}

async function getJson<T>(path: string): Promise<T> {
  const base = getVaultApiBase();
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${path}`);
  }
  return (await res.json()) as T;
}

export async function listVaults(): Promise<string[]> {
  const data = await getJson<{ vaults: string[] }>('/api/vaults');
  return data.vaults;
}

export async function getVault(name: string): Promise<VaultDetail> {
  return await getJson<VaultDetail>(
    `/api/vaults/${encodeURIComponent(name)}/pages`,
  );
}

export async function deleteVault(name: string): Promise<void> {
  const base = getVaultApiBase();
  const res = await fetch(`${base}/api/vaults/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: delete ${name}`);
  }
}

export async function getPageMarkdown(
  vault: string,
  slug: string,
): Promise<string> {
  const base = getVaultApiBase();
  const res = await fetch(
    `${base}/api/vaults/${encodeURIComponent(vault)}/pages/${encodeURIComponent(slug)}`,
  );
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: page ${slug}`);
  }
  return await res.text();
}

/**
 * POST a multipart compile request and stream NDJSON events back.
 * Caller iterates with `for await (const ev of compileVault(...)) {}`.
 */
export async function* compileVault(
  vaultName: string,
  files: File[],
  apiKey: string,
  options: {
    provider?: string;
    model?: string;
  } = {},
): AsyncGenerator<WikiCompileEvent> {
  const base = getVaultApiBase();
  const fd = new FormData();
  fd.set('api_key', apiKey);
  fd.set('provider', options.provider ?? 'anthropic');
  if (options.model) fd.set('model', options.model);
  for (const f of files) fd.append('files', f);

  const res = await fetch(
    `${base}/api/vaults/${encodeURIComponent(vaultName)}/compile`,
    { method: 'POST', body: fd },
  );
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          yield JSON.parse(line) as WikiCompileEvent;
        } catch {
          /* skip malformed line */
        }
      }
      idx = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer) as WikiCompileEvent;
    } catch {
      /* ignore trailing garbage */
    }
  }
}
