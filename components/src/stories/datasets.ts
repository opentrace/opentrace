import type { GraphNode, GraphLink } from '../types/graph';

export interface Dataset {
  name: string;
  description: string;
  nodes: GraphNode[];
  links: GraphLink[];
}

// ─── Microservices Architecture ──────────────────────────────────────────

const microservicesNodes: GraphNode[] = [
  { id: 'api-gw', name: 'API Gateway', type: 'Service', properties: { language: 'Go' } },
  { id: 'user-svc', name: 'UserService', type: 'Service', properties: { language: 'TypeScript' } },
  { id: 'order-svc', name: 'OrderService', type: 'Service', properties: { language: 'Python' } },
  { id: 'payment-svc', name: 'PaymentService', type: 'Service', properties: { language: 'Go' } },
  { id: 'notify-svc', name: 'NotificationService', type: 'Service', properties: { language: 'TypeScript' } },
  { id: 'inventory-svc', name: 'InventoryService', type: 'Service', properties: { language: 'Rust' } },
  { id: 'search-svc', name: 'SearchService', type: 'Service', properties: { language: 'Python' } },
  { id: 'auth-svc', name: 'AuthService', type: 'Service', properties: { language: 'Go' } },
  { id: 'users-db', name: 'users_db', type: 'Database', properties: { engine: 'PostgreSQL' } },
  { id: 'orders-db', name: 'orders_db', type: 'Database', properties: { engine: 'PostgreSQL' } },
  { id: 'redis', name: 'session_cache', type: 'Database', properties: { engine: 'Redis' } },
  { id: 'elastic', name: 'search_index', type: 'Database', properties: { engine: 'Elasticsearch' } },
  { id: 'kafka', name: 'event_bus', type: 'Service', properties: { kind: 'message-broker' } },
  { id: 'ep-login', name: 'POST /login', type: 'Endpoint' },
  { id: 'ep-signup', name: 'POST /signup', type: 'Endpoint' },
  { id: 'ep-orders', name: 'GET /orders', type: 'Endpoint' },
  { id: 'ep-checkout', name: 'POST /checkout', type: 'Endpoint' },
  { id: 'ep-search', name: 'GET /search', type: 'Endpoint' },
  { id: 'ep-inventory', name: 'GET /inventory', type: 'Endpoint' },
];

const microservicesLinks: GraphLink[] = [
  { source: 'api-gw', target: 'user-svc', label: 'CALLS' },
  { source: 'api-gw', target: 'order-svc', label: 'CALLS' },
  { source: 'api-gw', target: 'search-svc', label: 'CALLS' },
  { source: 'api-gw', target: 'inventory-svc', label: 'CALLS' },
  { source: 'api-gw', target: 'auth-svc', label: 'CALLS' },
  { source: 'user-svc', target: 'users-db', label: 'READS' },
  { source: 'user-svc', target: 'users-db', label: 'WRITES' },
  { source: 'user-svc', target: 'redis', label: 'READS' },
  { source: 'auth-svc', target: 'redis', label: 'READS' },
  { source: 'auth-svc', target: 'redis', label: 'WRITES' },
  { source: 'auth-svc', target: 'users-db', label: 'READS' },
  { source: 'order-svc', target: 'orders-db', label: 'READS' },
  { source: 'order-svc', target: 'orders-db', label: 'WRITES' },
  { source: 'order-svc', target: 'payment-svc', label: 'CALLS' },
  { source: 'order-svc', target: 'inventory-svc', label: 'CALLS' },
  { source: 'order-svc', target: 'kafka', label: 'PUBLISHES' },
  { source: 'payment-svc', target: 'orders-db', label: 'WRITES' },
  { source: 'notify-svc', target: 'kafka', label: 'SUBSCRIBES' },
  { source: 'search-svc', target: 'elastic', label: 'READS' },
  { source: 'inventory-svc', target: 'orders-db', label: 'READS' },
  { source: 'ep-login', target: 'auth-svc', label: 'DEFINED_IN' },
  { source: 'ep-signup', target: 'user-svc', label: 'DEFINED_IN' },
  { source: 'ep-orders', target: 'order-svc', label: 'DEFINED_IN' },
  { source: 'ep-checkout', target: 'order-svc', label: 'DEFINED_IN' },
  { source: 'ep-search', target: 'search-svc', label: 'DEFINED_IN' },
  { source: 'ep-inventory', target: 'inventory-svc', label: 'DEFINED_IN' },
];

// ─── Code Structure ─────────────────────────────────────────────────────

const codeNodes: GraphNode[] = [
  { id: 'repo', name: 'opentrace/opentrace', type: 'Repository' },
  { id: 'dir-src', name: 'src', type: 'Directory' },
  { id: 'dir-services', name: 'src/services', type: 'Directory' },
  { id: 'dir-models', name: 'src/models', type: 'Directory' },
  { id: 'dir-utils', name: 'src/utils', type: 'Directory' },
  { id: 'dir-api', name: 'src/api', type: 'Directory' },
  { id: 'file-user-svc', name: 'user.service.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'file-order-svc', name: 'order.service.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'file-auth-svc', name: 'auth.service.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'file-user-model', name: 'user.model.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'file-order-model', name: 'order.model.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'file-logger', name: 'logger.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'file-config', name: 'config.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'file-routes', name: 'routes.ts', type: 'File', properties: { language: 'TypeScript' } },
  { id: 'class-user-svc', name: 'UserService', type: 'Class', properties: { language: 'TypeScript' } },
  { id: 'class-order-svc', name: 'OrderService', type: 'Class', properties: { language: 'TypeScript' } },
  { id: 'class-auth-svc', name: 'AuthService', type: 'Class', properties: { language: 'TypeScript' } },
  { id: 'class-user', name: 'User', type: 'Class', properties: { language: 'TypeScript' } },
  { id: 'class-order', name: 'Order', type: 'Class', properties: { language: 'TypeScript' } },
  { id: 'fn-validate', name: 'validateToken', type: 'Function', properties: { language: 'TypeScript' } },
  { id: 'fn-hash', name: 'hashPassword', type: 'Function', properties: { language: 'TypeScript' } },
  { id: 'fn-log', name: 'createLogger', type: 'Function', properties: { language: 'TypeScript' } },
  { id: 'fn-routes', name: 'registerRoutes', type: 'Function', properties: { language: 'TypeScript' } },
  { id: 'fn-get-user', name: 'getUserById', type: 'Function', properties: { language: 'TypeScript' } },
  { id: 'fn-create-order', name: 'createOrder', type: 'Function', properties: { language: 'TypeScript' } },
];

const codeLinks: GraphLink[] = [
  // Directory structure
  { source: 'dir-src', target: 'repo', label: 'DEFINED_IN' },
  { source: 'dir-services', target: 'dir-src', label: 'DEFINED_IN' },
  { source: 'dir-models', target: 'dir-src', label: 'DEFINED_IN' },
  { source: 'dir-utils', target: 'dir-src', label: 'DEFINED_IN' },
  { source: 'dir-api', target: 'dir-src', label: 'DEFINED_IN' },
  // Files in dirs
  { source: 'file-user-svc', target: 'dir-services', label: 'DEFINED_IN' },
  { source: 'file-order-svc', target: 'dir-services', label: 'DEFINED_IN' },
  { source: 'file-auth-svc', target: 'dir-services', label: 'DEFINED_IN' },
  { source: 'file-user-model', target: 'dir-models', label: 'DEFINED_IN' },
  { source: 'file-order-model', target: 'dir-models', label: 'DEFINED_IN' },
  { source: 'file-logger', target: 'dir-utils', label: 'DEFINED_IN' },
  { source: 'file-config', target: 'dir-utils', label: 'DEFINED_IN' },
  { source: 'file-routes', target: 'dir-api', label: 'DEFINED_IN' },
  // Classes in files
  { source: 'class-user-svc', target: 'file-user-svc', label: 'DEFINED_IN' },
  { source: 'class-order-svc', target: 'file-order-svc', label: 'DEFINED_IN' },
  { source: 'class-auth-svc', target: 'file-auth-svc', label: 'DEFINED_IN' },
  { source: 'class-user', target: 'file-user-model', label: 'DEFINED_IN' },
  { source: 'class-order', target: 'file-order-model', label: 'DEFINED_IN' },
  // Functions in files
  { source: 'fn-validate', target: 'file-auth-svc', label: 'DEFINED_IN' },
  { source: 'fn-hash', target: 'file-auth-svc', label: 'DEFINED_IN' },
  { source: 'fn-log', target: 'file-logger', label: 'DEFINED_IN' },
  { source: 'fn-routes', target: 'file-routes', label: 'DEFINED_IN' },
  { source: 'fn-get-user', target: 'file-user-svc', label: 'DEFINED_IN' },
  { source: 'fn-create-order', target: 'file-order-svc', label: 'DEFINED_IN' },
  // Cross-file calls
  { source: 'class-auth-svc', target: 'class-user-svc', label: 'CALLS' },
  { source: 'class-order-svc', target: 'class-user-svc', label: 'CALLS' },
  { source: 'fn-routes', target: 'class-auth-svc', label: 'CALLS' },
  { source: 'fn-routes', target: 'class-order-svc', label: 'CALLS' },
  { source: 'fn-get-user', target: 'class-user', label: 'CALLS' },
  { source: 'fn-create-order', target: 'class-order', label: 'CALLS' },
  { source: 'fn-create-order', target: 'fn-validate', label: 'CALLS' },
  // Imports
  { source: 'file-user-svc', target: 'file-user-model', label: 'IMPORTS' },
  { source: 'file-order-svc', target: 'file-order-model', label: 'IMPORTS' },
  { source: 'file-order-svc', target: 'file-user-svc', label: 'IMPORTS' },
  { source: 'file-auth-svc', target: 'file-user-svc', label: 'IMPORTS' },
  { source: 'file-auth-svc', target: 'file-logger', label: 'IMPORTS' },
  { source: 'file-routes', target: 'file-auth-svc', label: 'IMPORTS' },
  { source: 'file-routes', target: 'file-order-svc', label: 'IMPORTS' },
  { source: 'file-routes', target: 'file-config', label: 'IMPORTS' },
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

function generateLargeDataset(
  nodeCount: number,
  edgeDensity: number,
): { nodes: GraphNode[]; links: GraphLink[] } {
  const rand = mulberry32(nodeCount * 31 + 7);
  const types = ['Service', 'Function', 'File', 'Class', 'Module', 'Database', 'Endpoint'];
  const labels = ['CALLS', 'IMPORTS', 'DEFINED_IN', 'READS', 'WRITES'];
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const type = types[i % types.length];
    nodes.push({
      id: `n-${i}`,
      name: `${type}_${i}`,
      type,
    });
  }

  // Create a connected tree first (ensures connectivity)
  for (let i = 1; i < nodeCount; i++) {
    const parent = Math.floor(rand() * i);
    links.push({
      source: `n-${i}`,
      target: `n-${parent}`,
      label: labels[i % labels.length],
    });
  }

  // Add additional random edges
  const extraEdges = Math.floor(nodeCount * edgeDensity);
  for (let i = 0; i < extraEdges; i++) {
    const s = Math.floor(rand() * nodeCount);
    let t = Math.floor(rand() * nodeCount);
    if (t === s) t = (t + 1) % nodeCount;
    links.push({
      source: `n-${s}`,
      target: `n-${t}`,
      label: labels[Math.floor(rand() * labels.length)],
    });
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
    get nodes() { return getData().nodes; },
    get links() { return getData().links; },
  };
}

// ─── Minimal ────────────────────────────────────────────────────────────

const minimalNodes: GraphNode[] = [
  { id: 'a', name: 'Alpha', type: 'Service' },
  { id: 'b', name: 'Beta', type: 'Service' },
  { id: 'c', name: 'Gamma', type: 'Database' },
];

const minimalLinks: GraphLink[] = [
  { source: 'a', target: 'b', label: 'CALLS' },
  { source: 'b', target: 'c', label: 'READS' },
  { source: 'a', target: 'c', label: 'WRITES' },
];

// ─── Export ──────────────────────────────────────────────────────────────

export const DATASETS: Dataset[] = [
  {
    name: 'Microservices',
    description: 'Microservices architecture with APIs, databases, and message queues',
    nodes: microservicesNodes,
    links: microservicesLinks,
  },
  {
    name: 'Code Structure',
    description: 'Repository with directories, files, classes, and functions',
    nodes: codeNodes,
    links: codeLinks,
  },
  {
    name: 'Minimal',
    description: '3 nodes, 3 edges — minimal graph for testing',
    nodes: minimalNodes,
    links: minimalLinks,
  },
  lazyDataset('100 nodes', 'Generated graph with 100 nodes', 100, 1.5),
  lazyDataset('500 nodes', 'Generated graph with 500 nodes', 500, 1.2),
  lazyDataset('2,000 nodes', 'Stress test — 2k nodes', 2000, 1.0),
  lazyDataset('5,000 nodes', 'Stress test — 5k nodes', 5000, 0.8),
  lazyDataset('10,000 nodes', 'Stress test — 10k nodes', 10000, 0.6),
  lazyDataset('15,000 nodes', 'Stress test — 15k nodes', 15000, 0.5),
  lazyDataset('20,000 nodes', 'Stress test — 20k nodes', 20000, 0.4),
  lazyDataset('25,000 nodes', 'Stress test — 25k nodes', 25000, 0.35),
  lazyDataset('30,000 nodes', 'Stress test — 30k nodes', 30000, 0.3),
];
