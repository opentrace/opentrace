/**
 * Isolated LadybugDB WASM test — no React, no pipeline.
 *
 * Creates a DB, generates nodes/rels using the storybook dataset
 * generator, writes them via CSV COPY FROM in chunks, and reports
 * timing + WASM memory at each step.
 *
 * Uses @ladybugdb/wasm-core 0.15.2 (async worker-based API).
 *
 * Open at: http://localhost:5174/test-db.html
 */

import lbug from '@ladybugdb/wasm-core';

// ── Dataset generator ──

function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TestNode { id: string; name: string; type: string; properties?: Record<string, unknown> }
interface TestRel { id: string; source_id: string; target_id: string; type: string }

function generateDataset(nodeCount: number): { nodes: TestNode[]; rels: TestRel[] } {
  const rand = mulberry32(nodeCount * 31 + 7);
  const nodes: TestNode[] = [];
  const rels: TestRel[] = [];

  const typeWeights = [
    { type: 'Repository', weight: 0.02 },
    { type: 'Directory', weight: 0.08 },
    { type: 'File', weight: 0.30 },
    { type: 'Class', weight: 0.20 },
    { type: 'Function', weight: 0.35 },
    { type: 'Package', weight: 0.05 },
  ];

  function pickType(): string {
    const r = rand();
    let cum = 0;
    for (const { type, weight } of typeWeights) {
      cum += weight;
      if (r < cum) return type;
    }
    return 'Function';
  }

  const byType: Record<string, number[]> = {
    Repository: [], Directory: [], File: [], Class: [], Function: [], Package: [],
  };

  for (let i = 0; i < nodeCount; i++) {
    const type = i === 0 ? 'Repository' : pickType();
    const name = `${type.toLowerCase()}_${i}`;
    nodes.push({
      id: `n-${i}`,
      name,
      type,
      properties: { language: 'TypeScript', path: `src/${name}.ts` },
    });
    byType[type].push(i);
  }

  const repos = byType.Repository;
  const dirs = byType.Directory;
  const files = byType.File;
  const classes = byType.Class;
  const functions = byType.Function;

  for (const d of dirs) {
    const parent = repos.length > 0 ? repos[Math.floor(rand() * repos.length)] : 0;
    rels.push({ id: `r-di-${d}`, source_id: `n-${d}`, target_id: `n-${parent}`, type: 'DEFINED_IN' });
  }
  for (const f of files) {
    const parent = dirs.length > 0 ? dirs[Math.floor(rand() * dirs.length)] : 0;
    rels.push({ id: `r-di-${f}`, source_id: `n-${f}`, target_id: `n-${parent}`, type: 'DEFINED_IN' });
  }
  for (const c of classes) {
    const parent = files.length > 0 ? files[Math.floor(rand() * files.length)] : 0;
    rels.push({ id: `r-di-${c}`, source_id: `n-${c}`, target_id: `n-${parent}`, type: 'DEFINED_IN' });
  }
  for (const fn of functions) {
    const parent = files.length > 0 ? files[Math.floor(rand() * files.length)] : 0;
    rels.push({ id: `r-di-${fn}`, source_id: `n-${fn}`, target_id: `n-${parent}`, type: 'DEFINED_IN' });
  }
  for (let i = 0; i < functions.length * 0.3; i++) {
    const a = functions[Math.floor(rand() * functions.length)];
    const b = functions[Math.floor(rand() * functions.length)];
    if (a !== b) {
      rels.push({ id: `r-call-${i}`, source_id: `n-${a}`, target_id: `n-${b}`, type: 'CALLS' });
    }
  }

  return { nodes, rels };
}

// ── CSV helpers ──

function csvEscape(value: string): string {
  const safe = (value ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, '""');
  return '"' + safe + '"';
}

const encoder = new TextEncoder();

function nodeCSV(nodes: TestNode[]): Uint8Array {
  const lines = ['id,name,properties'];
  for (const n of nodes) {
    const props = JSON.stringify(n.properties ?? {});
    lines.push([n.id, n.name, props].map(csvEscape).join(','));
  }
  return encoder.encode(lines.join('\n'));
}

const REL_PAIRS = [
  'Function_Function', 'Function_File', 'Function_Class',
  'Class_File', 'Class_Class',
  'File_Directory', 'File_File', 'File_Package', 'File_Repository',
  'Directory_Directory', 'Directory_Repository',
  'Repository_Package',
];
const REL_PAIR_SET = new Set(REL_PAIRS);

function relCSV(rels: TestRel[], nodeTypeMap: Map<string, string>): Uint8Array {
  const lines = ['from,to,id,type,properties'];
  for (const r of rels) {
    const srcType = nodeTypeMap.get(r.source_id);
    const tgtType = nodeTypeMap.get(r.target_id);
    if (!srcType || !tgtType || !REL_PAIR_SET.has(`${srcType}_${tgtType}`)) continue;
    lines.push([r.source_id, r.target_id, r.id, r.type, '{}'].map(csvEscape).join(','));
  }
  return encoder.encode(lines.join('\n'));
}

// ── Logging ──

const logEl = document.getElementById('log')!;
function log(msg: string, cls: 'ok' | 'err' | 'info' = 'info') {
  const line = document.createElement('div');
  line.className = cls;
  line.textContent = `[${performance.now().toFixed(0)}ms] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Main test ──

const CHUNK = 500;
const NODE_TYPES = ['Repository', 'Directory', 'File', 'Package', 'Class', 'Function'];

async function runTest(nodeCount: number) {
  logEl.innerHTML = '';
  log(`=== Test: ${nodeCount} nodes ===`);

  // 1. Init
  log('Initializing WASM module...');
  try {
    // Worker script must be served from the correct path.
    // In Vite dev mode, node_modules are served directly.
    lbug.setWorkerPath('/lbug_wasm_worker.js');
    await lbug.init();
    const version = await lbug.getVersion();
    log(`WASM loaded — LadybugDB ${version}`, 'ok');
  } catch (err) {
    log(`WASM init failed: ${err}`, 'err');
    return;
  }

  let db: InstanceType<typeof lbug.Database>;
  let conn: InstanceType<typeof lbug.Connection>;

  try {
    db = new lbug.Database(':memory:');
    await db.init();
    conn = new lbug.Connection(db);
    await conn.init();
    log('Database + Connection created', 'ok');
  } catch (err) {
    log(`Database/Connection failed: ${err}`, 'err');
    return;
  }

  // 2. Schema
  log('Creating schema...');
  for (const type of NODE_TYPES) {
    const r = await conn.query(`CREATE NODE TABLE IF NOT EXISTS ${type}(id STRING PRIMARY KEY, name STRING, properties STRING)`);
    await r.close();
  }
  const pairs = [
    'FROM Function TO Function', 'FROM Function TO File', 'FROM Function TO Class',
    'FROM Class TO File', 'FROM Class TO Class',
    'FROM File TO Directory', 'FROM File TO File', 'FROM File TO Package', 'FROM File TO Repository',
    'FROM Directory TO Directory', 'FROM Directory TO Repository',
    'FROM Repository TO Package',
  ].join(', ');
  const relResult = await conn.query(`CREATE REL TABLE GROUP IF NOT EXISTS RELATES(${pairs}, id STRING, type STRING, properties STRING)`);
  await relResult.close();
  log('Schema ready', 'ok');

  // 3. Generate data
  log(`Generating ${nodeCount} nodes...`);
  const { nodes, rels } = generateDataset(nodeCount);
  log(`Generated ${nodes.length} nodes, ${rels.length} rels`, 'ok');

  const nodeTypeMap = new Map<string, string>();
  for (const n of nodes) nodeTypeMap.set(n.id, n.type);

  // 4. Insert nodes in chunks via CSV COPY
  const buckets = new Map<string, TestNode[]>();
  for (const n of nodes) {
    let b = buckets.get(n.type);
    if (!b) { b = []; buckets.set(n.type, b); }
    b.push(n);
  }

  let totalInserted = 0;
  for (const [type, bucket] of buckets) {
    log(`Inserting ${bucket.length} ${type} nodes in chunks of ${CHUNK}...`);
    for (let offset = 0; offset < bucket.length; offset += CHUNK) {
      const chunk = bucket.slice(offset, offset + CHUNK);
      const csv = nodeCSV(chunk);
      const path = `/nodes_${type}.csv`;
      await lbug.FS.writeFile(path, csv);
      try {
        const r = await conn.query(`COPY ${type} FROM '${path}' (HEADER=true)`);
        await r.close();
        totalInserted += chunk.length;
        await lbug.FS.unlink(path);
      } catch (err) {
        log(`COPY ${type} CRASHED at offset ${offset}: ${err}`, 'err');
        try { await lbug.FS.unlink(path); } catch { /* */ }
        return;
      }
    }
    log(`  ${type}: done`, 'ok');
  }
  log(`All ${totalInserted} nodes inserted`, 'ok');

  // 5. Insert rels in chunks
  const relBuckets = new Map<string, TestRel[]>();
  for (const r of rels) {
    const srcType = nodeTypeMap.get(r.source_id)!;
    const tgtType = nodeTypeMap.get(r.target_id)!;
    const key = `${srcType}_${tgtType}`;
    if (!REL_PAIR_SET.has(key)) continue;
    let b = relBuckets.get(key);
    if (!b) { b = []; relBuckets.set(key, b); }
    b.push(r);
  }

  let totalRels = 0;
  for (const [key, bucket] of relBuckets) {
    for (let offset = 0; offset < bucket.length; offset += CHUNK) {
      const chunk = bucket.slice(offset, offset + CHUNK);
      const csv = relCSV(chunk, nodeTypeMap);
      const path = `/rels_${key}.csv`;
      await lbug.FS.writeFile(path, csv);
      try {
        const r = await conn.query(`COPY RELATES_${key} FROM '${path}' (HEADER=true)`);
        await r.close();
        totalRels += chunk.length;
        await lbug.FS.unlink(path);
      } catch (err) {
        log(`COPY RELATES_${key} CRASHED at ${offset}: ${err}`, 'err');
        try { await lbug.FS.unlink(path); } catch { /* */ }
        return;
      }
    }
  }
  log(`All ${totalRels} rels inserted`, 'ok');

  // 6. Verify
  for (const type of NODE_TYPES) {
    const r = await conn.query(`MATCH (n:${type}) RETURN count(n) AS cnt`);
    const rows = await r.getAllObjects();
    await r.close();
    if (rows.length > 0) {
      log(`  ${type}: ${rows[0].cnt} rows`);
    }
  }

  const relCountResult = await conn.query('MATCH ()-[r:RELATES]->() RETURN count(r) AS cnt');
  const relCountRows = await relCountResult.getAllObjects();
  await relCountResult.close();
  if (relCountRows.length > 0) {
    log(`  RELATES: ${relCountRows[0].cnt} rows`);
  }

  log(`\n=== DONE: ${totalInserted} nodes, ${totalRels} rels ===`, 'ok');

  // Cleanup
  conn.close();
  db.close();
}

// Expose to window for button onclick
(window as unknown as Record<string, unknown>).runTest = runTest;
