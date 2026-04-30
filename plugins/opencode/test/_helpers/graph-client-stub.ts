/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

import type { GraphClient } from "../../src/graph-client.js"

/** GraphClient stub: gates pass, queries return null/[]/empty stats. */
export function makeGraphClientStub(overrides: Partial<GraphClient> = {}): GraphClient {
  const base: any = {
    requireDbAvailable: async () => null,
    requireCliAvailable: async () => null,
    isCliAvailable: () => true,
    dbReadyHint: () => true,
    ensureCli: async () => true,
    sourceSearchText: async () => null,
    sourceGrepText: async () => null,
    ftsSearch: async () => [],
    augment: async () => null,
    impact: async () => null,
    getNode: async () => null,
    traverse: async () => [],
    readSource: async () => null,
    repos: async () => [],
    listRepos: async () => [],
    indexRepo: async () => ({ ok: true, message: "" }),
    stats: async () => null,
  }
  return Object.assign(base, overrides) as GraphClient
}
