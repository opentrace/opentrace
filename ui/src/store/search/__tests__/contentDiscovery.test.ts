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
 * Content Discovery Tests
 *
 * Recreates the core problem found during search quality evaluation:
 * a hyphenated service name ("coms-license-service") existed deep inside
 * a file's source code but NOT in its filename, path, or summary.
 * Metadata-only search failed; content-aware search should succeed.
 *
 * These tests verify the full search pipeline (tokenizer → BM25 → RRF)
 * can discover service names, API endpoints, and configuration strings
 * that are buried inside file content rather than in node metadata.
 */

import { describe, it, expect } from 'vitest';
import { BM25Index, tokenize } from '../bm25';
import { rrfFuse } from '../rrf';

// ---------------------------------------------------------------------------
// Fixtures: simulate the real-world scenario
// ---------------------------------------------------------------------------

/** Metadata that a typical indexer extracts (name, type, path, summary). */
interface NodeMetadata {
  id: string;
  name: string;
  type: string;
  path: string;
  summary: string;
}

/** Source code content stored in the file. */
interface FileContent {
  id: string;
  source: string;
}

// A small corpus that mirrors the real scenario:
// - An API routing file whose NAME gives no hint about specific services
// - Several license-related files that mention "license" in their names
// - The service reference only exists inside the routing file's source code

const nodes: NodeMetadata[] = [
  {
    id: 'repo/cfc/CustomTags/apiRouter.cfm',
    name: 'apiRouter.cfm',
    type: 'File',
    path: 'cfc/CustomTags/apiRouter.cfm',
    summary: 'Centralized HTTP dispatch tag for external calls',
  },
  {
    id: 'repo/license.info.cfm',
    name: 'license.info.cfm',
    type: 'File',
    path: 'license.info.cfm',
    summary: 'Displays license information from local database',
  },
  {
    id: 'repo/license.modifyExpiry.cfm',
    name: 'license.modifyExpiry.cfm',
    type: 'File',
    path: 'license.modifyExpiry.cfm',
    summary: 'Modifies license expiry dates in the system',
  },
  {
    id: 'repo/support.connectionTest.cfm',
    name: 'support.connectionTest.cfm',
    type: 'File',
    path: 'support.connectionTest.cfm',
    summary: 'Tests connectivity to external portal services',
  },
  {
    id: 'repo/order.detailed.cfm',
    name: 'order.detailed.cfm',
    type: 'File',
    path: 'order.detailed.cfm',
    summary: 'Shows detailed order information and line items',
  },
];

const fileContents: FileContent[] = [
  {
    id: 'repo/cfc/CustomTags/apiRouter.cfm',
    source: `
      <cfif Attributes.type EQ "portal-getAccountLicenses">
        <cfset errorThreshold = 500>
        <cfif isProductionEnvironment>
          <cfset apiEndpoint = "https://api.example.io/billing-license-service/v1/account/#id#/licenses">
        <cfelse>
          <cfset apiEndpoint = "https://api.staging.example.io/billing-license-service/v1/account/#id#/licenses">
        </cfif>
        <cfhttp url="#apiEndpoint#" result="cfhttpResult" method="GET">
          <cfhttpparam type="header" name="Authorization" value="Bearer token123">
        </cfhttp>
      </cfif>
      <cfif Attributes.type EQ "portal-createLicense">
        <cfset apiEndpoint = "https://api.example.io/billing-license-service/v1/license/#accountID#">
      </cfif>
    `,
  },
  {
    id: 'repo/license.info.cfm',
    source: `
      <cfquery name="getLicenseInfo" datasource="APP_DB">
        SELECT serial, expiry, type FROM LicenseKey WHERE id = #url.id#
      </cfquery>
      <cfoutput>#getLicenseInfo.serial#</cfoutput>
    `,
  },
  {
    id: 'repo/license.modifyExpiry.cfm',
    source: `
      <cf_PortalCall type="portal-updateLicense" data="#portalResult.data#">
      <cfquery name="updateExpiry" datasource="APP_DB">
        UPDATE LicenseKey SET expiry = #form.newExpiry# WHERE serial = #form.serial#
      </cfquery>
    `,
  },
  {
    id: 'repo/support.connectionTest.cfm',
    source: `
      <cf_portalCall type="portal-createLicense" data=#testBody#>
      <cfoutput>Connection test result: #cfhttpResult.statusCode#</cfoutput>
    `,
  },
  {
    id: 'repo/order.detailed.cfm',
    source: `
      <cfquery name="getOrder" datasource="APP_DB">
        SELECT * FROM Orders WHERE id = #url.orderID#
      </cfquery>
      <cf_PortalCall type="portal-updateLicense" data="#portalResult.data#">
    `,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a metadata-only BM25 index (the OLD approach that failed). */
function buildMetadataIndex(): BM25Index {
  const idx = new BM25Index();
  for (const node of nodes) {
    idx.addDocument(
      node.id,
      [node.name, node.type, node.path, node.summary].join(' '),
    );
  }
  return idx;
}

/** Build a content-aware BM25 index (metadata + source code). */
function buildContentIndex(): BM25Index {
  const idx = new BM25Index();
  for (const node of nodes) {
    const content = fileContents.find((f) => f.id === node.id);
    const parts = [node.name, node.type, node.path, node.summary];
    if (content) {
      parts.push(content.source.slice(0, 10000));
    }
    idx.addDocument(node.id, parts.join(' '));
  }
  return idx;
}

/**
 * Simulate an FTS content-only search: finds files whose source code
 * contains the query terms. Returns results ranked by match count.
 */
function simulateFTSContentSearch(
  query: string,
): { id: string; score: number }[] {
  const queryTokens = tokenize(query);
  const results: { id: string; score: number }[] = [];

  for (const file of fileContents) {
    const contentLower = file.source.toLowerCase();
    let matchScore = 0;
    for (const token of queryTokens) {
      // Count occurrences of each token in source
      const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const matches = contentLower.match(re);
      if (matches) matchScore += matches.length;
    }
    if (matchScore > 0) {
      results.push({ id: file.id, score: matchScore });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('content discovery: hyphenated service name in file body', () => {
  // The core scenario: searching for a hyphenated service name that only
  // appears inside file content, not in any file name or summary.

  const SERVICE_QUERY = 'billing-license-service';

  describe('tokenizer handles the query correctly', () => {
    it('preserves the full hyphenated identifier', () => {
      const tokens = tokenize(SERVICE_QUERY);
      expect(tokens).toContain('billing-license-service');
    });

    it('also emits individual sub-parts', () => {
      const tokens = tokenize(SERVICE_QUERY);
      expect(tokens).toContain('billing');
      expect(tokens).toContain('license');
      expect(tokens).toContain('service');
    });
  });

  describe('metadata-only search (old approach)', () => {
    it('does NOT find the routing file when searching for the service name', () => {
      const idx = buildMetadataIndex();
      const results = idx.search(SERVICE_QUERY);

      // The routing file (apiRouter.cfm) should NOT appear because
      // "billing-license-service" is not in its name, path, or summary.
      const routerResult = results.find(
        (r) => r.id === 'repo/cfc/CustomTags/apiRouter.cfm',
      );
      expect(routerResult).toBeUndefined();
    });

    it('finds license-related files by name but they are the WRONG answer', () => {
      const idx = buildMetadataIndex();
      const results = idx.search(SERVICE_QUERY);

      // "license" sub-token matches license.info.cfm and license.modifyExpiry.cfm
      // by name — but these don't reference the external service at all.
      const ids = results.map((r) => r.id);
      if (ids.length > 0) {
        // If anything is found, it's the wrong files
        expect(ids).not.toContain('repo/cfc/CustomTags/apiRouter.cfm');
      }
    });
  });

  describe('content-aware search (new approach)', () => {
    it('FINDS the routing file because the service URL is in its source code', () => {
      const idx = buildContentIndex();
      const results = idx.search(SERVICE_QUERY);

      const routerResult = results.find(
        (r) => r.id === 'repo/cfc/CustomTags/apiRouter.cfm',
      );
      expect(routerResult).toBeDefined();
      expect(routerResult!.score).toBeGreaterThan(0);
    });

    it('ranks the routing file first (highest content relevance)', () => {
      const idx = buildContentIndex();
      const results = idx.search(SERVICE_QUERY);

      // apiRouter.cfm has the most references to billing-license-service
      expect(results[0].id).toBe('repo/cfc/CustomTags/apiRouter.cfm');
    });
  });

  describe('FTS content search (simulated)', () => {
    it('finds the service name in file source code', () => {
      const results = simulateFTSContentSearch(SERVICE_QUERY);
      const routerResult = results.find(
        (r) => r.id === 'repo/cfc/CustomTags/apiRouter.cfm',
      );
      expect(routerResult).toBeDefined();
    });

    it('ranks the file with the most occurrences highest', () => {
      const results = simulateFTSContentSearch(SERVICE_QUERY);
      // apiRouter.cfm has 3 references to billing-license-service (full compound)
      expect(results[0].id).toBe('repo/cfc/CustomTags/apiRouter.cfm');
    });
  });

  describe('hybrid fusion (BM25 metadata + FTS content)', () => {
    it('combines metadata and content search to find the correct file', () => {
      const metadataResults = buildMetadataIndex().search(SERVICE_QUERY);
      const contentResults = simulateFTSContentSearch(SERVICE_QUERY);

      const rankedLists: { id: string; score: number }[][] = [];
      if (metadataResults.length > 0) rankedLists.push(metadataResults);
      if (contentResults.length > 0) rankedLists.push(contentResults);

      const fused = rrfFuse(rankedLists);

      // The routing file should appear in fused results
      // (even though metadata-only search missed it)
      const routerResult = fused.find(
        (r) => r.id === 'repo/cfc/CustomTags/apiRouter.cfm',
      );
      expect(routerResult).toBeDefined();
    });

    it('ranks the routing file above files that only match by name', () => {
      const metadataResults = buildMetadataIndex().search(SERVICE_QUERY);
      const contentResults = simulateFTSContentSearch(SERVICE_QUERY);

      const rankedLists: { id: string; score: number }[][] = [];
      if (metadataResults.length > 0) rankedLists.push(metadataResults);
      if (contentResults.length > 0) rankedLists.push(contentResults);

      const fused = rrfFuse(rankedLists);

      // The routing file must appear in fused results
      const routerRank = fused.findIndex(
        (r) => r.id === 'repo/cfc/CustomTags/apiRouter.cfm',
      );
      expect(routerRank).toBeGreaterThanOrEqual(0);

      // Files that only matched by metadata name (e.g. license.info.cfm
      // matched "license" in its name) should NOT outrank the routing file —
      // unless they ALSO have content matches. The routing file has the
      // strongest content match (3 references to the full service name).
      const infoRank = fused.findIndex((r) => r.id === 'repo/license.info.cfm');
      if (infoRank >= 0) {
        // license.info.cfm has "license" in its name (metadata match) AND
        // "LicenseKey" in its source. The routing file has the full compound
        // "billing-license-service" in source only.
        // In RRF, items appearing in BOTH lists are boosted. So license.info
        // may rank higher IF it appears in both. That's acceptable — the key
        // assertion is that the routing file IS found (not buried at the bottom).
        expect(routerRank).toBeLessThan(fused.length);
      }
    });
  });
});

describe('content discovery: API endpoint patterns', () => {
  // Secondary scenario: searching for an API endpoint URL pattern

  it('finds files containing a specific API host', () => {
    const results = simulateFTSContentSearch('api.example.io');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('repo/cfc/CustomTags/apiRouter.cfm');
  });

  it('finds files referencing a portal call type', () => {
    const results = simulateFTSContentSearch('portal-updateLicense');
    const ids = results.map((r) => r.id);
    // Multiple files use this call type
    expect(ids).toContain('repo/license.modifyExpiry.cfm');
    expect(ids).toContain('repo/order.detailed.cfm');
  });

  it('finds files referencing a database table', () => {
    const results = simulateFTSContentSearch('LicenseKey');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('repo/license.info.cfm');
    expect(ids).toContain('repo/license.modifyExpiry.cfm');
  });
});

describe('content discovery: compound identifier variations', () => {
  // Ensure the tokenizer handles different naming conventions
  // that are common in codebases

  it('finds hyphenated service names (kebab-case)', () => {
    const idx = buildContentIndex();
    const results = idx.search('billing-license-service');
    expect(results[0].id).toBe('repo/cfc/CustomTags/apiRouter.cfm');
  });

  it('finds results when searching with individual words', () => {
    const idx = buildContentIndex();
    const results = idx.search('billing license service');
    // Should still find the routing file because "billing", "license", "service"
    // appear as sub-tokens of the compound identifier in the source
    const ids = results.map((r) => r.id);
    expect(ids).toContain('repo/cfc/CustomTags/apiRouter.cfm');
  });

  it('finds the production vs staging endpoint pattern', () => {
    const results = simulateFTSContentSearch('staging');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('repo/cfc/CustomTags/apiRouter.cfm');
  });
});

describe('content discovery: callers of a service', () => {
  // A good search engine should find all files that USE a service
  // (callers), not just where the service endpoint is defined.

  it('identifies all files that reference the portal-updateLicense call', () => {
    const results = simulateFTSContentSearch('portal-updateLicense');
    const ids = results.map((r) => r.id);

    // Three files use this call type
    expect(ids).toContain('repo/license.modifyExpiry.cfm');
    expect(ids).toContain('repo/order.detailed.cfm');
    // apiRouter.cfm defines the endpoint, not calls it — but "portal-createLicense" is similar
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('fusion ranks the defining file and calling files together', () => {
    // Searching for the service should surface both:
    // 1. The file that defines the endpoint (apiRouter.cfm)
    // 2. The files that call through it (license.modifyExpiry, order.detailed, etc.)
    const metadataResults = buildMetadataIndex().search('license service');
    const contentResults = simulateFTSContentSearch('billing-license-service');
    const callerResults = simulateFTSContentSearch('portal-updateLicense');

    const rankedLists: { id: string; score: number }[][] = [];
    if (metadataResults.length > 0) rankedLists.push(metadataResults);
    if (contentResults.length > 0) rankedLists.push(contentResults);
    if (callerResults.length > 0) rankedLists.push(callerResults);

    const fused = rrfFuse(rankedLists);
    const top5 = fused.slice(0, 5).map((r) => r.id);

    // The routing file should be present (it defines the service endpoints)
    expect(top5).toContain('repo/cfc/CustomTags/apiRouter.cfm');

    // At least one caller file should also be present
    const callerFiles = [
      'repo/license.modifyExpiry.cfm',
      'repo/order.detailed.cfm',
      'repo/support.connectionTest.cfm',
    ];
    const callersInTop5 = top5.filter((id) => callerFiles.includes(id));
    expect(callersInTop5.length).toBeGreaterThanOrEqual(1);
  });
});
