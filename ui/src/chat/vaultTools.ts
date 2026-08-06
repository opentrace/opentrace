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
 * LangChain tools that let the chat agent discover the knowledge vaults
 * attached to this project, so it can ground answers in the user's ingested
 * documents instead of guessing.
 *
 * Reading a vault's CONTENT is not here. A document is a graph node, so it is
 * reached with the graph tools in ``./tools`` — ``search_graph`` /
 * ``list_nodes`` to find one, ``load_source`` to read it verbatim, ``grep``
 * to sweep every body at once.
 */

import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { isVaultApiConfigured, listVaults } from '../wiki/client';

const listVaultsSchema = z.object({});

function jsonError(action: string, e: unknown): string {
  return JSON.stringify({
    error: e instanceof Error ? e.message : String(e),
    action,
  });
}

export function makeVaultTools() {
  // No server, no vault API — return no tools rather than an advertised tool
  // that can only throw. An advertised tool is a capability the agent will
  // spend a call on.
  if (!isVaultApiConfigured()) return [];

  const listVaultsTool = tool(
    async () => {
      try {
        // The chat agent operates against this project's graph, so only
        // surface vaults that are actually attached here — globals not
        // attached to the project aren't visible from the graph and
        // can't be queried by name without an attach step.
        const entries = await listVaults('project');
        return JSON.stringify({ vaults: entries.map((e) => e.name) });
      } catch (e) {
        return jsonError('list_vaults', e);
      }
    },
    {
      name: 'list_vaults',
      description:
        'List all knowledge vaults attached to this project. A vault is a ' +
        'collection of ingested documents: find them with search_graph or ' +
        'list_nodes("KnowledgeDoc"), read one verbatim with load_source, and ' +
        'sweep every body at once with grep (scopeId = the vault name). ' +
        'Use this first to discover what knowledge is available. ' +
        'Returns: {vaults: string[]}.',
      schema: listVaultsSchema,
    },
  );

  return [listVaultsTool];
}
