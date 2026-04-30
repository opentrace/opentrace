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
 * LangChain tools that let the chat agent read knowledge vaults compiled
 * via the wiki pipeline. The agent uses these to ground answers in the
 * user's uploaded documents instead of guessing.
 *
 * All tools hit the same REST endpoints the VaultBrowser uses
 * (``/api/vaults/*`` on ``opentraceai serve``), via the helpers in
 * ``../wiki/client``. No new transport.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getPageMarkdown, getVault, listVaults } from '../wiki/client';

const MAX_PAGE_CHARS = 20_000;

const listVaultsSchema = z.object({});

const listVaultPagesSchema = z.object({
  vault: z
    .string()
    .describe('The vault name (from list_vaults). Case-sensitive.'),
});

const readVaultPageSchema = z.object({
  vault: z.string().describe('The vault name.'),
  slug: z
    .string()
    .describe(
      'The page slug (from list_vault_pages). Lowercase, kebab-case form ' +
        'of the page title. NOT the title itself — convert spaces/punctuation to dashes.',
    ),
});

function jsonError(action: string, e: unknown): string {
  return JSON.stringify({
    error: e instanceof Error ? e.message : String(e),
    action,
  });
}

export function makeVaultTools() {
  const listVaultsTool = tool(
    async () => {
      try {
        const vaults = await listVaults();
        return JSON.stringify({ vaults });
      } catch (e) {
        return jsonError('list_vaults', e);
      }
    },
    {
      name: 'list_vaults',
      description:
        'List all knowledge vaults the user has compiled. Each vault is a ' +
        'collection of LLM-compiled markdown pages produced from uploaded files. ' +
        'Use this first to discover what knowledge is available before reading pages. ' +
        'Returns: {vaults: string[]}.',
      schema: listVaultsSchema,
    },
  );

  const listPagesTool = tool(
    async ({ vault }: z.infer<typeof listVaultPagesSchema>) => {
      try {
        const detail = await getVault(vault);
        return JSON.stringify({
          name: detail.name,
          last_compiled_at: detail.last_compiled_at,
          pages: detail.pages.map((p) => ({
            slug: p.slug,
            title: p.title,
            summary: p.one_line_summary,
            revision: p.revision,
          })),
        });
      } catch (e) {
        return jsonError('list_vault_pages', e);
      }
    },
    {
      name: 'list_vault_pages',
      description:
        'List the pages in a vault as {slug, title, one-line summary}. Use ' +
        'these summaries to decide which page(s) to read in detail with ' +
        'read_vault_page. Returns: {name, pages: [{slug, title, summary, revision}]}.',
      schema: listVaultPagesSchema,
    },
  );

  const readPageTool = tool(
    async ({ vault, slug }: z.infer<typeof readVaultPageSchema>) => {
      try {
        const body = await getPageMarkdown(vault, slug);
        const truncated = body.length > MAX_PAGE_CHARS;
        const content = truncated ? body.slice(0, MAX_PAGE_CHARS) : body;
        return JSON.stringify({
          vault,
          slug,
          markdown: content,
          truncated,
          length: body.length,
        });
      } catch (e) {
        return jsonError('read_vault_page', e);
      }
    },
    {
      name: 'read_vault_page',
      description:
        'Read the full markdown body of a single vault page. Use this to ' +
        'pull facts directly from the source — the page may contain ' +
        '[[Other Page Title]] wiki-links you can follow with another ' +
        'read_vault_page call (convert the title to a slug: lowercase, ' +
        'spaces/punctuation → dashes). Pages are LLM-summarised from the ' +
        "user's uploaded documents. Returns: {markdown, truncated, length}.",
      schema: readVaultPageSchema,
    },
  );

  return [listVaultsTool, listPagesTool, readPageTool];
}
