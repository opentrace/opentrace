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

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { runPipeline, initParsers } from '../pipeline';
import { MemoryStore } from '../store/memory';
import type { PipelineEvent } from '../types';
import { getPhpParser, getPythonParser, makeRepoTree } from './helpers';

beforeAll(async () => {
  const pyParser = await getPythonParser();
  const phpParser = await getPhpParser();
  initParsers(
    new Map([
      ['python', pyParser],
      ['php', phpParser],
    ]),
  );
});

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

async function readAllFiles(
  dir: string,
): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await readAllFiles(fullPath)));
    } else {
      results.push({
        path: relative(dir, fullPath),
        content: await readFile(fullPath, 'utf-8'),
      });
    }
  }
  return results;
}

function runAndLog(
  files: Array<{ path: string; content: string }>,
  opts: { owner: string; repo: string },
): { events: PipelineEvent[]; store: MemoryStore } {
  const store = new MemoryStore();
  const repo = makeRepoTree(files, opts);
  const events: PipelineEvent[] = [];

  for (const event of runPipeline({ repo }, { cancelled: false }, store)) {
    events.push(event);
    const detail = event.detail
      ? ` [${event.detail.current}/${event.detail.total} ${event.detail.fileName ?? ''}]`
      : '';
    const nodeCount = event.nodes ? ` nodes=${event.nodes.length}` : '';
    const relCount = event.relationships
      ? ` rels=${event.relationships.length}`
      : '';
    console.log(
      `  ${event.kind.padEnd(14)} ${event.phase.padEnd(8)} ${event.message}${detail}${nodeCount}${relCount}`,
    );
  }

  return { events, store };
}

/** Count unique directories from file paths. */
function countDirs(files: Array<{ path: string }>): number {
  const dirs = new Set<string>();
  for (const f of files) {
    let dir = f.path;
    while (dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      dirs.add(dir);
    }
  }
  return dirs.size;
}

describe('fixture: Go project', () => {
  it('indexes Go project and saves to store', async () => {
    const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'go', 'project');
    const files = await readAllFiles(fixtureDir);

    const { events, store } = runAndLog(files, {
      owner: 'fixture',
      repo: 'go-project',
    });

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    expect(
      events.some((e) => e.kind === 'stage_stop' && e.phase === 'submitting'),
    ).toBe(true);

    // Store has structural + package nodes
    const packageNodes = [...store.nodes.values()].filter(
      (n) => n.type === 'Dependency',
    );
    expect(store.nodes.size).toBeGreaterThanOrEqual(
      files.length + 1 + countDirs(files),
    );
    expect([...store.nodes.values()].some((n) => n.type === 'Repository')).toBe(
      true,
    );
    expect(
      [...store.nodes.values()].filter((n) => n.type === 'File'),
    ).toHaveLength(files.length);
    expect(packageNodes.length).toBeGreaterThan(0);

    // All relationship endpoints are valid nodes
    for (const rel of store.relationships.values()) {
      expect(store.nodes.has(rel.source_id)).toBe(true);
      expect(store.nodes.has(rel.target_id)).toBe(true);
    }

    // Go files are parseable but no Go parser loaded in test — only structural output
    const goFiles = files.filter((f) => f.path.endsWith('.go'));
    expect(done!.result?.filesProcessed).toBe(goFiles.length);
  });
});

describe('fixture: Python project', () => {
  it('indexes Python project and saves to store', async () => {
    const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'python', 'project');
    const files = await readAllFiles(fixtureDir);

    const { events, store } = runAndLog(files, {
      owner: 'fixture',
      repo: 'py-project',
    });

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();

    // Structural nodes
    const repoNode = store.nodes.get('fixture/py-project');
    expect(repoNode).toBeDefined();
    expect(repoNode!.type).toBe('Repository');

    const fileNodes = [...store.nodes.values()].filter(
      (n) => n.type === 'File',
    );
    expect(fileNodes).toHaveLength(files.length);

    // Python files were parsed — expect symbols
    const pyFiles = files.filter((f) => f.path.endsWith('.py'));
    expect(done!.result?.filesProcessed).toBe(pyFiles.length);

    // db.py has: class Database with 4 methods (__init__, initialize, get_all_users, insert_user)
    const dbClass = store.nodes.get('fixture/py-project/db.py::Database');
    expect(dbClass).toBeDefined();
    expect(dbClass!.type).toBe('Class');

    const initMethod = store.nodes.get(
      'fixture/py-project/db.py::Database::__init__(str)',
    );
    expect(initMethod).toBeDefined();
    expect(initMethod!.type).toBe('Function');

    const getAllUsers = store.nodes.get(
      'fixture/py-project/db.py::Database::get_all_users()',
    );
    expect(getAllUsers).toBeDefined();

    const insertUser = store.nodes.get(
      'fixture/py-project/db.py::Database::insert_user(str,str)',
    );
    expect(insertUser).toBeDefined();

    // main.py has: list_users, create_user (top-level functions)
    const listUsers = store.nodes.get(
      'fixture/py-project/main.py::list_users()',
    );
    expect(listUsers).toBeDefined();
    expect(listUsers!.type).toBe('Function');

    const createUser = store.nodes.get(
      'fixture/py-project/main.py::create_user()',
    );
    expect(createUser).toBeDefined();

    // Class DEFINES its methods (parent → child)
    const initRel = [...store.relationships.values()].find(
      (r) =>
        r.target_id === 'fixture/py-project/db.py::Database::__init__(str)',
    );
    expect(initRel?.source_id).toBe('fixture/py-project/db.py::Database');

    // File DEFINES the class (parent → child)
    const classRel = [...store.relationships.values()].find(
      (r) => r.target_id === 'fixture/py-project/db.py::Database',
    );
    expect(classRel?.source_id).toBe('fixture/py-project/db.py');

    // All DEFINES relationships point to valid nodes
    const definedInRels = [...store.relationships.values()].filter(
      (r) => r.type === 'DEFINES',
    );
    for (const rel of definedInRels) {
      expect(store.nodes.has(rel.source_id)).toBe(true);
      expect(store.nodes.has(rel.target_id)).toBe(true);
    }

    // CALLS and IMPORTS relationships should also have valid endpoints
    const callRels = [...store.relationships.values()].filter(
      (r) => r.type === 'CALLS',
    );
    const importRels = [...store.relationships.values()].filter(
      (r) => r.type === 'IMPORTS',
    );
    expect(callRels.length).toBeGreaterThan(0);
    expect(importRels.length).toBeGreaterThan(0);

    // Stats
    // db.py::Database + service.py::UserService = 2 classes
    expect(done!.result!.classesExtracted).toBe(2);
    // db.py: 4 methods + main.py: 2 functions + service.py: 4 methods + 3 functions = 13
    expect(done!.result!.functionsExtracted).toBe(13);
  });
});

describe('fixture: PHP project', () => {
  it('indexes PHP project and extracts namespaced classes', async () => {
    const fixtureDir = join(repoRoot, 'tests', 'fixtures', 'php', 'project');
    const files = await readAllFiles(fixtureDir);

    const { events, store } = runAndLog(files, {
      owner: 'fixture',
      repo: 'php-project',
    });

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();

    // Repository + File nodes
    const repoNode = store.nodes.get('fixture/php-project');
    expect(repoNode?.type).toBe('Repository');

    const fileNodes = [...store.nodes.values()].filter(
      (n) => n.type === 'File',
    );
    expect(fileNodes).toHaveLength(files.length);

    // Only .php files are parsed
    const phpFiles = files.filter((f) => f.path.endsWith('.php'));
    expect(done!.result?.filesProcessed).toBe(phpFiles.length);

    // UserDatabase class + methods
    const userDb = store.nodes.get(
      'fixture/php-project/src/Database/UserDatabase.php::UserDatabase',
    );
    expect(userDb).toBeDefined();
    expect(userDb!.type).toBe('Class');

    const classNodes = [...store.nodes.values()].filter(
      (n) => n.type === 'Class',
    );
    const classNames = classNodes.map((n) => n.name).sort();
    expect(classNames).toContain('UserDatabase');
    expect(classNames).toContain('UserController');

    // Methods exist as Function nodes beneath the class
    const userDbMethods = [...store.nodes.values()].filter(
      (n) =>
        n.type === 'Function' &&
        n.id.startsWith(
          'fixture/php-project/src/Database/UserDatabase.php::UserDatabase::',
        ),
    );
    const methodNames = userDbMethods.map((n) => n.name);
    expect(methodNames.some((n) => n.startsWith('__construct'))).toBe(true);
    expect(methodNames.some((n) => n.startsWith('initializeSchema'))).toBe(
      true,
    );
    expect(methodNames.some((n) => n.startsWith('getAllUsers'))).toBe(true);
    expect(methodNames.some((n) => n.startsWith('insertUser'))).toBe(true);

    // All DEFINES relationship endpoints point to valid nodes
    for (const rel of store.relationships.values()) {
      expect(store.nodes.has(rel.source_id)).toBe(true);
      expect(store.nodes.has(rel.target_id)).toBe(true);
    }

    // Stats: UserDatabase (4 methods) + UserController (3 methods) = 2 classes, 7 functions
    expect(done!.result!.classesExtracted).toBe(2);
    expect(done!.result!.functionsExtracted).toBe(7);
  });
});
