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

import type { GraphNode, GraphLink } from '../types/graph';

export interface Dataset {
  name: string;
  description: string;
  nodes: GraphNode[];
  links: GraphLink[];
}

// ─── Node types & edge labels used across all datasets ───────────────────

// ─── Web App (hand-crafted) ──────────────────────────────────────────────

const webAppNodes: GraphNode[] = [
  // Repo
  { id: 'repo', name: 'acme/web-app', type: 'Repo' },
  // Packages
  {
    id: 'pkg-react',
    name: 'react',
    type: 'Package',
    properties: { version: '19.2.0' },
  },
  {
    id: 'pkg-express',
    name: 'express',
    type: 'Package',
    properties: { version: '5.1.0' },
  },
  {
    id: 'pkg-prisma',
    name: '@prisma/client',
    type: 'Package',
    properties: { version: '6.9.0' },
  },
  {
    id: 'pkg-zod',
    name: 'zod',
    type: 'Package',
    properties: { version: '3.25.0' },
  },
  // Directories
  { id: 'dir-src', name: 'src', type: 'Directory' },
  { id: 'dir-server', name: 'src/server', type: 'Directory' },
  { id: 'dir-client', name: 'src/client', type: 'Directory' },
  { id: 'dir-models', name: 'src/server/models', type: 'Directory' },
  { id: 'dir-routes', name: 'src/server/routes', type: 'Directory' },
  { id: 'dir-components', name: 'src/client/components', type: 'Directory' },
  { id: 'dir-hooks', name: 'src/client/hooks', type: 'Directory' },
  // Server files
  {
    id: 'file-app',
    name: 'app.ts',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-user-model',
    name: 'user.model.ts',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-order-model',
    name: 'order.model.ts',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-user-routes',
    name: 'user.routes.ts',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-order-routes',
    name: 'order.routes.ts',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-auth-middleware',
    name: 'auth.middleware.ts',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  // Client files
  {
    id: 'file-app-tsx',
    name: 'App.tsx',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-user-list',
    name: 'UserList.tsx',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-order-table',
    name: 'OrderTable.tsx',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'file-use-fetch',
    name: 'useFetch.ts',
    type: 'File',
    properties: { language: 'TypeScript' },
  },
  // Classes
  {
    id: 'class-user',
    name: 'User',
    type: 'Class',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'class-order',
    name: 'Order',
    type: 'Class',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'class-auth',
    name: 'AuthMiddleware',
    type: 'Class',
    properties: { language: 'TypeScript' },
  },
  // Functions
  {
    id: 'fn-get-users',
    name: 'getUsers',
    type: 'Function',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'fn-create-order',
    name: 'createOrder',
    type: 'Function',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'fn-validate-token',
    name: 'validateToken',
    type: 'Function',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'fn-hash-password',
    name: 'hashPassword',
    type: 'Function',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'fn-use-fetch',
    name: 'useFetch',
    type: 'Function',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'fn-render-users',
    name: 'UserList',
    type: 'Function',
    properties: { language: 'TypeScript' },
  },
  {
    id: 'fn-render-orders',
    name: 'OrderTable',
    type: 'Function',
    properties: { language: 'TypeScript' },
  },
];

const webAppLinks: GraphLink[] = [
  // Directory structure (DEFINED_IN)
  { source: 'dir-src', target: 'repo', label: 'DEFINED_IN' },
  { source: 'dir-server', target: 'dir-src', label: 'DEFINED_IN' },
  { source: 'dir-client', target: 'dir-src', label: 'DEFINED_IN' },
  { source: 'dir-models', target: 'dir-server', label: 'DEFINED_IN' },
  { source: 'dir-routes', target: 'dir-server', label: 'DEFINED_IN' },
  { source: 'dir-components', target: 'dir-client', label: 'DEFINED_IN' },
  { source: 'dir-hooks', target: 'dir-client', label: 'DEFINED_IN' },
  // Files in directories
  { source: 'file-app', target: 'dir-server', label: 'DEFINED_IN' },
  { source: 'file-user-model', target: 'dir-models', label: 'DEFINED_IN' },
  { source: 'file-order-model', target: 'dir-models', label: 'DEFINED_IN' },
  { source: 'file-user-routes', target: 'dir-routes', label: 'DEFINED_IN' },
  { source: 'file-order-routes', target: 'dir-routes', label: 'DEFINED_IN' },
  { source: 'file-auth-middleware', target: 'dir-server', label: 'DEFINED_IN' },
  { source: 'file-app-tsx', target: 'dir-client', label: 'DEFINED_IN' },
  { source: 'file-user-list', target: 'dir-components', label: 'DEFINED_IN' },
  { source: 'file-order-table', target: 'dir-components', label: 'DEFINED_IN' },
  { source: 'file-use-fetch', target: 'dir-hooks', label: 'DEFINED_IN' },
  // Classes & functions in files
  { source: 'class-user', target: 'file-user-model', label: 'DEFINED_IN' },
  { source: 'class-order', target: 'file-order-model', label: 'DEFINED_IN' },
  { source: 'class-auth', target: 'file-auth-middleware', label: 'DEFINED_IN' },
  { source: 'fn-get-users', target: 'file-user-routes', label: 'DEFINED_IN' },
  {
    source: 'fn-create-order',
    target: 'file-order-routes',
    label: 'DEFINED_IN',
  },
  {
    source: 'fn-validate-token',
    target: 'file-auth-middleware',
    label: 'DEFINED_IN',
  },
  {
    source: 'fn-hash-password',
    target: 'file-user-model',
    label: 'DEFINED_IN',
  },
  { source: 'fn-use-fetch', target: 'file-use-fetch', label: 'DEFINED_IN' },
  { source: 'fn-render-users', target: 'file-user-list', label: 'DEFINED_IN' },
  {
    source: 'fn-render-orders',
    target: 'file-order-table',
    label: 'DEFINED_IN',
  },
  // CALLS
  { source: 'fn-get-users', target: 'class-user', label: 'CALLS' },
  { source: 'fn-create-order', target: 'class-order', label: 'CALLS' },
  { source: 'fn-create-order', target: 'fn-validate-token', label: 'CALLS' },
  { source: 'fn-get-users', target: 'fn-validate-token', label: 'CALLS' },
  { source: 'fn-render-users', target: 'fn-use-fetch', label: 'CALLS' },
  { source: 'fn-render-orders', target: 'fn-use-fetch', label: 'CALLS' },
  { source: 'class-auth', target: 'fn-validate-token', label: 'CALLS' },
  { source: 'class-user', target: 'fn-hash-password', label: 'CALLS' },
  // IMPORTS
  { source: 'file-user-routes', target: 'file-user-model', label: 'IMPORTS' },
  { source: 'file-order-routes', target: 'file-order-model', label: 'IMPORTS' },
  {
    source: 'file-order-routes',
    target: 'file-auth-middleware',
    label: 'IMPORTS',
  },
  {
    source: 'file-user-routes',
    target: 'file-auth-middleware',
    label: 'IMPORTS',
  },
  { source: 'file-app', target: 'file-user-routes', label: 'IMPORTS' },
  { source: 'file-app', target: 'file-order-routes', label: 'IMPORTS' },
  { source: 'file-app-tsx', target: 'file-user-list', label: 'IMPORTS' },
  { source: 'file-app-tsx', target: 'file-order-table', label: 'IMPORTS' },
  { source: 'file-user-list', target: 'file-use-fetch', label: 'IMPORTS' },
  { source: 'file-order-table', target: 'file-use-fetch', label: 'IMPORTS' },
  // DEPENDS_ON (packages)
  { source: 'repo', target: 'pkg-react', label: 'DEPENDS_ON' },
  { source: 'repo', target: 'pkg-express', label: 'DEPENDS_ON' },
  { source: 'repo', target: 'pkg-prisma', label: 'DEPENDS_ON' },
  { source: 'repo', target: 'pkg-zod', label: 'DEPENDS_ON' },
  { source: 'file-user-model', target: 'pkg-prisma', label: 'IMPORTS' },
  { source: 'file-order-model', target: 'pkg-prisma', label: 'IMPORTS' },
  { source: 'file-app', target: 'pkg-express', label: 'IMPORTS' },
  { source: 'file-order-routes', target: 'pkg-zod', label: 'IMPORTS' },
];

// ─── Go Monorepo (hand-crafted) ─────────────────────────────────────────

const goMonorepoNodes: GraphNode[] = [
  { id: 'repo', name: 'acme/platform', type: 'Repo' },
  // Packages (external)
  { id: 'pkg-gin', name: 'github.com/gin-gonic/gin', type: 'Package' },
  { id: 'pkg-gorm', name: 'gorm.io/gorm', type: 'Package' },
  { id: 'pkg-grpc', name: 'google.golang.org/grpc', type: 'Package' },
  // Directories
  { id: 'dir-cmd', name: 'cmd', type: 'Directory' },
  { id: 'dir-internal', name: 'internal', type: 'Directory' },
  { id: 'dir-pkg', name: 'pkg', type: 'Directory' },
  { id: 'dir-cmd-api', name: 'cmd/api', type: 'Directory' },
  { id: 'dir-cmd-worker', name: 'cmd/worker', type: 'Directory' },
  { id: 'dir-user', name: 'internal/user', type: 'Directory' },
  { id: 'dir-order', name: 'internal/order', type: 'Directory' },
  { id: 'dir-auth', name: 'internal/auth', type: 'Directory' },
  { id: 'dir-logger', name: 'pkg/logger', type: 'Directory' },
  { id: 'dir-config', name: 'pkg/config', type: 'Directory' },
  // Files
  {
    id: 'file-main-api',
    name: 'main.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-main-worker',
    name: 'main.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-user-handler',
    name: 'handler.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-user-repo',
    name: 'repository.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-user-service',
    name: 'service.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-order-handler',
    name: 'handler.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-order-service',
    name: 'service.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-auth-middleware',
    name: 'middleware.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-auth-jwt',
    name: 'jwt.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-logger',
    name: 'logger.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  {
    id: 'file-config',
    name: 'config.go',
    type: 'File',
    properties: { language: 'Go' },
  },
  // Classes (structs)
  {
    id: 'class-user-handler',
    name: 'UserHandler',
    type: 'Class',
    properties: { language: 'Go' },
  },
  {
    id: 'class-user-repo',
    name: 'UserRepository',
    type: 'Class',
    properties: { language: 'Go' },
  },
  {
    id: 'class-user-service',
    name: 'UserService',
    type: 'Class',
    properties: { language: 'Go' },
  },
  {
    id: 'class-order-handler',
    name: 'OrderHandler',
    type: 'Class',
    properties: { language: 'Go' },
  },
  {
    id: 'class-order-service',
    name: 'OrderService',
    type: 'Class',
    properties: { language: 'Go' },
  },
  {
    id: 'class-auth-mw',
    name: 'AuthMiddleware',
    type: 'Class',
    properties: { language: 'Go' },
  },
  // Functions
  {
    id: 'fn-main-api',
    name: 'main',
    type: 'Function',
    properties: { language: 'Go' },
  },
  {
    id: 'fn-main-worker',
    name: 'main',
    type: 'Function',
    properties: { language: 'Go' },
  },
  {
    id: 'fn-list-users',
    name: 'ListUsers',
    type: 'Function',
    properties: { language: 'Go' },
  },
  {
    id: 'fn-get-user',
    name: 'GetUser',
    type: 'Function',
    properties: { language: 'Go' },
  },
  {
    id: 'fn-create-order',
    name: 'CreateOrder',
    type: 'Function',
    properties: { language: 'Go' },
  },
  {
    id: 'fn-verify-token',
    name: 'VerifyToken',
    type: 'Function',
    properties: { language: 'Go' },
  },
  {
    id: 'fn-new-logger',
    name: 'New',
    type: 'Function',
    properties: { language: 'Go' },
  },
  {
    id: 'fn-load-config',
    name: 'Load',
    type: 'Function',
    properties: { language: 'Go' },
  },
];

const goMonorepoLinks: GraphLink[] = [
  // Directory tree
  { source: 'dir-cmd', target: 'repo', label: 'DEFINED_IN' },
  { source: 'dir-internal', target: 'repo', label: 'DEFINED_IN' },
  { source: 'dir-pkg', target: 'repo', label: 'DEFINED_IN' },
  { source: 'dir-cmd-api', target: 'dir-cmd', label: 'DEFINED_IN' },
  { source: 'dir-cmd-worker', target: 'dir-cmd', label: 'DEFINED_IN' },
  { source: 'dir-user', target: 'dir-internal', label: 'DEFINED_IN' },
  { source: 'dir-order', target: 'dir-internal', label: 'DEFINED_IN' },
  { source: 'dir-auth', target: 'dir-internal', label: 'DEFINED_IN' },
  { source: 'dir-logger', target: 'dir-pkg', label: 'DEFINED_IN' },
  { source: 'dir-config', target: 'dir-pkg', label: 'DEFINED_IN' },
  // Files in dirs
  { source: 'file-main-api', target: 'dir-cmd-api', label: 'DEFINED_IN' },
  { source: 'file-main-worker', target: 'dir-cmd-worker', label: 'DEFINED_IN' },
  { source: 'file-user-handler', target: 'dir-user', label: 'DEFINED_IN' },
  { source: 'file-user-repo', target: 'dir-user', label: 'DEFINED_IN' },
  { source: 'file-user-service', target: 'dir-user', label: 'DEFINED_IN' },
  { source: 'file-order-handler', target: 'dir-order', label: 'DEFINED_IN' },
  { source: 'file-order-service', target: 'dir-order', label: 'DEFINED_IN' },
  { source: 'file-auth-middleware', target: 'dir-auth', label: 'DEFINED_IN' },
  { source: 'file-auth-jwt', target: 'dir-auth', label: 'DEFINED_IN' },
  { source: 'file-logger', target: 'dir-logger', label: 'DEFINED_IN' },
  { source: 'file-config', target: 'dir-config', label: 'DEFINED_IN' },
  // Classes/functions in files
  {
    source: 'class-user-handler',
    target: 'file-user-handler',
    label: 'DEFINED_IN',
  },
  { source: 'class-user-repo', target: 'file-user-repo', label: 'DEFINED_IN' },
  {
    source: 'class-user-service',
    target: 'file-user-service',
    label: 'DEFINED_IN',
  },
  {
    source: 'class-order-handler',
    target: 'file-order-handler',
    label: 'DEFINED_IN',
  },
  {
    source: 'class-order-service',
    target: 'file-order-service',
    label: 'DEFINED_IN',
  },
  {
    source: 'class-auth-mw',
    target: 'file-auth-middleware',
    label: 'DEFINED_IN',
  },
  { source: 'fn-main-api', target: 'file-main-api', label: 'DEFINED_IN' },
  { source: 'fn-main-worker', target: 'file-main-worker', label: 'DEFINED_IN' },
  { source: 'fn-list-users', target: 'file-user-handler', label: 'DEFINED_IN' },
  { source: 'fn-get-user', target: 'file-user-handler', label: 'DEFINED_IN' },
  {
    source: 'fn-create-order',
    target: 'file-order-handler',
    label: 'DEFINED_IN',
  },
  { source: 'fn-verify-token', target: 'file-auth-jwt', label: 'DEFINED_IN' },
  { source: 'fn-new-logger', target: 'file-logger', label: 'DEFINED_IN' },
  { source: 'fn-load-config', target: 'file-config', label: 'DEFINED_IN' },
  // CALLS
  { source: 'fn-main-api', target: 'fn-load-config', label: 'CALLS' },
  { source: 'fn-main-api', target: 'fn-new-logger', label: 'CALLS' },
  { source: 'fn-list-users', target: 'class-user-service', label: 'CALLS' },
  { source: 'fn-get-user', target: 'class-user-service', label: 'CALLS' },
  { source: 'class-user-service', target: 'class-user-repo', label: 'CALLS' },
  { source: 'fn-create-order', target: 'class-order-service', label: 'CALLS' },
  {
    source: 'class-order-service',
    target: 'class-user-service',
    label: 'CALLS',
  },
  { source: 'class-auth-mw', target: 'fn-verify-token', label: 'CALLS' },
  // IMPORTS
  { source: 'file-main-api', target: 'file-user-handler', label: 'IMPORTS' },
  { source: 'file-main-api', target: 'file-order-handler', label: 'IMPORTS' },
  { source: 'file-main-api', target: 'file-auth-middleware', label: 'IMPORTS' },
  { source: 'file-main-api', target: 'file-logger', label: 'IMPORTS' },
  { source: 'file-main-api', target: 'file-config', label: 'IMPORTS' },
  {
    source: 'file-user-handler',
    target: 'file-user-service',
    label: 'IMPORTS',
  },
  { source: 'file-user-service', target: 'file-user-repo', label: 'IMPORTS' },
  {
    source: 'file-order-handler',
    target: 'file-order-service',
    label: 'IMPORTS',
  },
  {
    source: 'file-order-service',
    target: 'file-user-service',
    label: 'IMPORTS',
  },
  { source: 'file-auth-middleware', target: 'file-auth-jwt', label: 'IMPORTS' },
  // DEPENDS_ON
  { source: 'repo', target: 'pkg-gin', label: 'DEPENDS_ON' },
  { source: 'repo', target: 'pkg-gorm', label: 'DEPENDS_ON' },
  { source: 'repo', target: 'pkg-grpc', label: 'DEPENDS_ON' },
  { source: 'file-main-api', target: 'pkg-gin', label: 'IMPORTS' },
  { source: 'file-user-repo', target: 'pkg-gorm', label: 'IMPORTS' },
];

// ─── Generated large dataset ─────────────────────────────────────────────

/** Simple seeded PRNG (mulberry32) for deterministic datasets */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a realistic code-graph dataset using only the standard
 * node types (Repo, Directory, File, Class, Function, Package) and
 * edge labels (DEFINED_IN, CALLS, IMPORTS, DEPENDS_ON).
 *
 * Structure: 1 Repo → directories → files → classes/functions,
 * plus packages with DEPENDS_ON and cross-file IMPORTS/CALLS.
 */
function generateLargeDataset(
  nodeCount: number,
  edgeDensity: number,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const rand = mulberry32(nodeCount * 31 + 7);
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  // Distribution: ~2% Repo, ~8% Directory, ~30% File, ~20% Class, ~35% Function, ~5% Package
  const typeWeights = [
    { type: 'Repo', weight: 0.02 },
    { type: 'Directory', weight: 0.08 },
    { type: 'File', weight: 0.3 },
    { type: 'Class', weight: 0.2 },
    { type: 'Function', weight: 0.35 },
    { type: 'Package', weight: 0.05 },
  ];

  // Assign types based on weights
  function pickType(): string {
    const r = rand();
    let cumulative = 0;
    for (const { type, weight } of typeWeights) {
      cumulative += weight;
      if (r < cumulative) return type;
    }
    return 'Function';
  }

  // Phase 1: Create nodes
  const byType: Record<string, number[]> = {
    Repo: [],
    Directory: [],
    File: [],
    Class: [],
    Function: [],
    Package: [],
  };

  for (let i = 0; i < nodeCount; i++) {
    const type = pickType();
    const name =
      type === 'Repo'
        ? `repo_${i}`
        : type === 'Directory'
          ? `dir_${i}`
          : type === 'File'
            ? `file_${i}.ts`
            : type === 'Class'
              ? `Class${i}`
              : type === 'Function'
                ? `func${i}`
                : `pkg_${i}`;
    nodes.push({ id: `n-${i}`, name, type });
    byType[type].push(i);
  }

  // Ensure at least one repo
  if (byType.Repo.length === 0 && nodes.length > 0) {
    nodes[0].type = 'Repo';
    nodes[0].name = 'repo_0';
    byType.Repo.push(0);
    // Remove from old type bucket
    for (const key of Object.keys(byType)) {
      if (key !== 'Repo') {
        const idx = byType[key].indexOf(0);
        if (idx !== -1) byType[key].splice(idx, 1);
      }
    }
  }

  // Phase 2: DEFINED_IN edges (structural tree)
  // Directories → Repo, Files → Directory, Classes/Functions → File
  const repos = byType.Repo;
  const dirs = byType.Directory;
  const files = byType.File;
  const classes = byType.Class;
  const functions = byType.Function;
  const packages = byType.Package;

  for (const d of dirs) {
    const parent = repos[Math.floor(rand() * repos.length)];
    links.push({
      source: `n-${d}`,
      target: `n-${parent}`,
      label: 'DEFINED_IN',
    });
  }
  for (const f of files) {
    const parent =
      dirs.length > 0
        ? dirs[Math.floor(rand() * dirs.length)]
        : repos[Math.floor(rand() * repos.length)];
    links.push({
      source: `n-${f}`,
      target: `n-${parent}`,
      label: 'DEFINED_IN',
    });
  }
  for (const c of classes) {
    if (files.length > 0) {
      const parent = files[Math.floor(rand() * files.length)];
      links.push({
        source: `n-${c}`,
        target: `n-${parent}`,
        label: 'DEFINED_IN',
      });
    }
  }
  for (const fn of functions) {
    if (files.length > 0) {
      const parent = files[Math.floor(rand() * files.length)];
      links.push({
        source: `n-${fn}`,
        target: `n-${parent}`,
        label: 'DEFINED_IN',
      });
    }
  }

  // Phase 3: DEPENDS_ON (repos → packages)
  for (const p of packages) {
    const repo = repos[Math.floor(rand() * repos.length)];
    links.push({ source: `n-${repo}`, target: `n-${p}`, label: 'DEPENDS_ON' });
  }

  // Phase 4: IMPORTS (file → file, file → package)
  const importCount = Math.floor(files.length * edgeDensity * 0.4);
  for (let i = 0; i < importCount; i++) {
    const s = files[Math.floor(rand() * files.length)];
    if (rand() < 0.2 && packages.length > 0) {
      const t = packages[Math.floor(rand() * packages.length)];
      links.push({ source: `n-${s}`, target: `n-${t}`, label: 'IMPORTS' });
    } else if (files.length > 1) {
      let t = files[Math.floor(rand() * files.length)];
      if (t === s) t = files[(files.indexOf(t) + 1) % files.length];
      links.push({ source: `n-${s}`, target: `n-${t}`, label: 'IMPORTS' });
    }
  }

  // Phase 5: CALLS (function → function, function → class, class → class)
  const callables = [...classes, ...functions];
  const callCount = Math.floor(callables.length * edgeDensity * 0.5);
  for (let i = 0; i < callCount; i++) {
    if (callables.length < 2) break;
    const s = callables[Math.floor(rand() * callables.length)];
    let t = callables[Math.floor(rand() * callables.length)];
    if (t === s) t = callables[(callables.indexOf(t) + 1) % callables.length];
    links.push({ source: `n-${s}`, target: `n-${t}`, label: 'CALLS' });
  }

  return { nodes, links };
}

/**
 * Lazy dataset wrapper — generates data on first access so large datasets
 * (10k+ nodes) don't slow down Storybook initial load.
 */
function lazyDataset(
  name: string,
  description: string,
  nodeCount: number,
  edgeDensity: number,
): Dataset {
  let cached: { nodes: GraphNode[]; links: GraphLink[] } | null = null;
  function getData() {
    if (!cached) cached = generateLargeDataset(nodeCount, edgeDensity);
    return cached;
  }
  return {
    name,
    description,
    get nodes() {
      return getData().nodes;
    },
    get links() {
      return getData().links;
    },
  };
}

// ─── Minimal ────────────────────────────────────────────────────────────

const minimalNodes: GraphNode[] = [
  { id: 'repo', name: 'acme/hello', type: 'Repo' },
  { id: 'file', name: 'main.go', type: 'File', properties: { language: 'Go' } },
  { id: 'fn', name: 'main', type: 'Function', properties: { language: 'Go' } },
];

const minimalLinks: GraphLink[] = [
  { source: 'file', target: 'repo', label: 'DEFINED_IN' },
  { source: 'fn', target: 'file', label: 'DEFINED_IN' },
];

// ─── Export ──────────────────────────────────────────────────────────────

export const DATASETS: Dataset[] = [
  {
    name: 'Web App',
    description: 'TypeScript web app with Express server and React client',
    nodes: webAppNodes,
    links: webAppLinks,
  },
  {
    name: 'Go Monorepo',
    description: 'Go monorepo with cmd/, internal/, pkg/ structure',
    nodes: goMonorepoNodes,
    links: goMonorepoLinks,
  },
  {
    name: 'Minimal',
    description: 'Repo → File → Function — smallest possible graph',
    nodes: minimalNodes,
    links: minimalLinks,
  },
  lazyDataset('100 nodes', 'Generated codebase with 100 nodes', 100, 1.5),
  lazyDataset('500 nodes', 'Generated codebase with 500 nodes', 500, 1.2),
  lazyDataset('2,000 nodes', 'Stress test — 2k nodes', 2000, 1.0),
  lazyDataset('5,000 nodes', 'Stress test — 5k nodes', 5000, 0.8),
  lazyDataset('10,000 nodes', 'Stress test — 10k nodes', 10000, 0.6),
  lazyDataset('15,000 nodes', 'Stress test — 15k nodes', 15000, 0.5),
  lazyDataset('20,000 nodes', 'Stress test — 20k nodes', 20000, 0.4),
  lazyDataset('25,000 nodes', 'Stress test — 25k nodes', 25000, 0.35),
  lazyDataset('30,000 nodes', 'Stress test — 30k nodes', 30000, 0.3),
];
