/**
 * Integration test: fetch a real GitHub repo tree and run the pipeline.
 *
 * Requires network access. Skipped by default in local runs.
 * Enable with: INTEGRATION=1 vitest run src/pipeline/__tests__/github.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { runPipeline, initParsers } from '../pipeline';
import { MemoryStore } from '../store/memory';
import type { PipelineEvent, RepoTree } from '../types';
import { getPythonParser } from './helpers';

const SKIP = !process.env.CI && !process.env.INTEGRATION;

beforeAll(async () => {
  if (SKIP) return;
  const pyParser = await getPythonParser();
  initParsers(new Map([['python', pyParser]]));
});

interface GitHubTreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

interface GitHubTreeResponse {
  sha: string;
  tree: GitHubTreeEntry[];
  truncated: boolean;
}

/**
 * Fetch the full recursive tree from GitHub's Git Trees API.
 * Returns only blob entries (files, not directories).
 */
async function fetchGitHubTree(
  owner: string,
  repo: string,
  ref: string,
): Promise<{ files: GitHubTreeEntry[]; sha: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'opentrace-pipeline-test',
  };
  // Use GITHUB_TOKEN if available (avoids rate limits in CI)
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }

  const data: GitHubTreeResponse = await res.json();
  const files = data.tree.filter((e) => e.type === 'blob');
  return { files, sha: data.sha };
}

describe.skipIf(SKIP)('github: grafana/grafana', () => {
  let repoTree: RepoTree;
  let fileCount: number;

  beforeAll(async () => {
    const { files, sha } = await fetchGitHubTree('grafana', 'grafana', 'main');
    fileCount = files.length;

    // Build RepoTree with empty content (we only test structural graph)
    repoTree = {
      owner: 'grafana',
      repo: 'grafana',
      ref: sha,
      url: 'https://github.com/grafana/grafana',
      provider: 'github',
      files: files.map((f) => ({ path: f.path, content: '' })),
    };
  }, 30_000);

  it('builds structural graph for 20k+ files', () => {
    expect(fileCount).toBeGreaterThan(20_000);

    const store = new MemoryStore();
    const events: PipelineEvent[] = [];
    const start = performance.now();

    for (const event of runPipeline(
      { repo: repoTree },
      { cancelled: false },
      store,
    )) {
      events.push(event);
    }

    const elapsed = performance.now() - start;
    console.log(`  Pipeline completed in ${elapsed.toFixed(0)}ms`);
    console.log(`  Files: ${fileCount}`);
    console.log(`  Nodes: ${store.nodes.size}`);
    console.log(`  Relationships: ${store.relationships.size}`);

    // Basic structural assertions
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();

    // 1 Repository + files + directories
    expect(store.nodes.size).toBeGreaterThan(fileCount);
    expect(
      [...store.nodes.values()].filter((n) => n.type === 'File'),
    ).toHaveLength(fileCount);
    expect(
      [...store.nodes.values()].filter((n) => n.type === 'Repository'),
    ).toHaveLength(1);
    expect(
      [...store.nodes.values()].filter((n) => n.type === 'Directory').length,
    ).toBeGreaterThan(0);

    // Every relationship points to valid nodes
    for (const rel of store.relationships.values()) {
      expect(
        store.nodes.has(rel.source_id),
        `missing source: ${rel.source_id}`,
      ).toBe(true);
      expect(
        store.nodes.has(rel.target_id),
        `missing target: ${rel.target_id}`,
      ).toBe(true);
    }

    // Should complete in a reasonable time (< 5s for structural graph)
    expect(elapsed).toBeLessThan(5_000);

    // All parseable files pass through the processing stage
    expect(done!.result?.filesProcessed).toBeGreaterThan(0);
  });

  it('event stream has correct lifecycle', () => {
    const events: PipelineEvent[] = [];
    for (const event of runPipeline({ repo: repoTree }, { cancelled: false })) {
      events.push(event);
    }

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('stage_start');
    expect(kinds).toContain('stage_progress');
    expect(kinds).toContain('stage_stop');
    expect(kinds).toContain('done');

    // Fetching progress events match file count
    const fetchProgress = events.filter(
      (e) => e.kind === 'stage_progress' && e.phase === 'scanning',
    );
    expect(fetchProgress).toHaveLength(fileCount);
    expect(fetchProgress[0].detail?.current).toBe(1);
    expect(fetchProgress[0].detail?.total).toBe(fileCount);
    expect(fetchProgress[fetchProgress.length - 1].detail?.current).toBe(
      fileCount,
    );

    // Fetching stage_stop carries all structural nodes
    const fetchStop = events.find(
      (e) => e.kind === 'stage_stop' && e.phase === 'scanning',
    );
    expect(fetchStop).toBeDefined();
    expect(fetchStop!.nodes!.length).toBeGreaterThan(fileCount);
  });
});
