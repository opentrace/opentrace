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
 * Community detection color palette and mapping utilities.
 * Separate from the type palette in nodeColors.ts to avoid confusion when toggling.
 * Uses warm/cool alternation for maximum perceptual distance on dark backgrounds.
 */

const COMMUNITY_PALETTE = [
  '#f472b6', // Pink
  '#38bdf8', // Sky
  '#fb923c', // Orange
  '#4ade80', // Green
  '#c084fc', // Purple
  '#fbbf24', // Amber
  '#22d3ee', // Cyan
  '#f87171', // Red
  '#a3e635', // Lime
  '#818cf8', // Indigo
  '#fb7185', // Rose
  '#2dd4bf', // Teal
  '#e879f9', // Fuchsia
  '#60a5fa', // Blue
  '#facc15', // Yellow
  '#34d399', // Emerald
];

const FALLBACK_COLOR = '#64748b'; // Slate grey

/**
 * Build a stable community→color mapping, sorted by member count (largest community
 * gets the first palette slot). This ensures the most prominent communities get the
 * most visually distinct colors.
 */
export function buildCommunityColorMap(
  assignments: Record<string, number>,
): Map<number, string> {
  // Count members per community
  const counts = new Map<number, number>();
  for (const communityId of Object.values(assignments)) {
    counts.set(communityId, (counts.get(communityId) || 0) + 1);
  }

  // Sort by count descending
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const colorMap = new Map<number, string>();
  for (let i = 0; i < sorted.length; i++) {
    colorMap.set(sorted[i][0], COMMUNITY_PALETTE[i % COMMUNITY_PALETTE.length]);
  }
  return colorMap;
}

// Node types that represent structural containers (ordered by priority — most specific first)
const CONTAINER_TYPES = ['Package', 'Directory', 'Repository'];

interface NameableNode {
  id: string;
  name: string;
  type: string;
}

/**
 * Derive a human-readable name for each community based on its member nodes.
 *
 * Strategy (in priority order):
 * 1. Highest-priority container node (Module > Package > Directory > ...)
 * 2. Longest common path prefix of node names (e.g., "src/components")
 * 3. Hub node — the node whose name appears most often as a prefix/substring
 *    in other members' names, or failing that, the shortest-named node
 *    (often the defining class/file of the cluster)
 * 4. Dominant node type + hub qualifier (e.g., "Functions · handleRequest")
 *
 * A final dedup pass appends the hub node name to any colliding labels.
 */
export function buildCommunityNames(
  assignments: Record<string, number>,
  nodes: NameableNode[],
): Map<number, string> {
  // Group nodes by community
  const groups = new Map<number, NameableNode[]>();
  for (const node of nodes) {
    const cid = assignments[node.id];
    if (cid === undefined) continue;
    let list = groups.get(cid);
    if (!list) {
      list = [];
      groups.set(cid, list);
    }
    list.push(node);
  }

  const names = new Map<number, string>();
  // Track hub node per community for dedup
  const hubs = new Map<number, string>();

  for (const [cid, members] of groups) {
    const hub = findHubNode(members);
    if (hub) hubs.set(cid, hub);

    // Strategy 1: Find the highest-priority container node
    let containerName: string | null = null;
    let bestPriority = CONTAINER_TYPES.length;
    for (const node of members) {
      const priority = CONTAINER_TYPES.indexOf(node.type);
      if (priority !== -1 && priority < bestPriority) {
        bestPriority = priority;
        containerName = node.name;
      }
    }
    if (containerName) {
      names.set(cid, containerName);
      continue;
    }

    // Strategy 2: Longest common path prefix
    const nodeNames = members.map((n) => n.name);
    const prefix = longestCommonPrefix(nodeNames);
    if (prefix.length > 0) {
      // Trim to last path separator for a clean directory-like name
      const trimmed = prefix.includes('/')
        ? prefix.slice(0, prefix.lastIndexOf('/') + 1)
        : prefix.includes('.')
          ? prefix.slice(0, prefix.lastIndexOf('.') + 1)
          : prefix;
      if (trimmed.length > 1) {
        names.set(cid, trimmed.replace(/\/$/, ''));
        continue;
      }
    }

    // Strategy 3: Hub node name directly (if it's distinctive enough)
    if (hub) {
      names.set(cid, hub);
      continue;
    }

    // Strategy 4: Dominant node type (last resort)
    const typeCounts = new Map<string, number>();
    for (const node of members) {
      typeCounts.set(node.type, (typeCounts.get(node.type) || 0) + 1);
    }
    let dominantType = 'Nodes';
    let maxCount = 0;
    for (const [type, count] of typeCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominantType = type;
      }
    }
    names.set(cid, pluralize(dominantType));
  }

  // Dedup: guarantee every community name is unique.
  // Pass 1: append hub qualifier to collisions.
  // Pass 2: if still colliding, append numeric suffix.
  dedup(names, hubs);

  return names;
}

/**
 * Find the most representative node in a community.
 * Picks the node whose name is a prefix/substring of the most other members,
 * breaking ties by shortest name (classes/files tend to be shorter than methods).
 */
function findHubNode(members: NameableNode[]): string | null {
  if (members.length === 0) return null;
  if (members.length === 1) return members[0].name;

  // Score each node by how many other members' names contain it as substring
  const scores: { name: string; score: number; len: number }[] = [];
  for (const node of members) {
    const lowerName = node.name.toLowerCase();
    // Skip very short names (single char, empty) — they'd match everything
    if (lowerName.length <= 1) continue;
    let score = 0;
    for (const other of members) {
      if (other === node) continue;
      if (other.name.toLowerCase().includes(lowerName)) score++;
    }
    scores.push({ name: node.name, score, len: node.name.length });
  }

  if (scores.length === 0) {
    // All names are very short — pick the shortest
    return members.reduce((a, b) => (a.name.length <= b.name.length ? a : b))
      .name;
  }

  // Sort by: highest score, then shortest name
  scores.sort((a, b) => b.score - a.score || a.len - b.len);

  return scores[0].name;
}

/** Mutates `names` until every value is unique. */
function dedup(names: Map<number, string>, hubs: Map<number, string>): void {
  // Collect collisions
  const byCid = () => {
    const map = new Map<string, number[]>();
    for (const [cid, name] of names) {
      let list = map.get(name);
      if (!list) {
        list = [];
        map.set(name, list);
      }
      list.push(cid);
    }
    return map;
  };

  // Pass 1: append hub qualifier
  for (const [, cids] of byCid()) {
    if (cids.length <= 1) continue;
    for (const cid of cids) {
      const hub = hubs.get(cid);
      const current = names.get(cid)!;
      if (hub && hub !== current && !current.includes(hub)) {
        names.set(cid, `${current} · ${hub}`);
      }
    }
  }

  // Pass 2: if still colliding, append numeric suffix
  for (const [, cids] of byCid()) {
    if (cids.length <= 1) continue;
    for (let i = 0; i < cids.length; i++) {
      const cid = cids[i];
      names.set(cid, `${names.get(cid)!} (${i + 1})`);
    }
  }
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  if (strings.length === 1) return strings[0];
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (!strings[i].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (prefix.length === 0) return '';
    }
  }
  return prefix;
}

function pluralize(type: string): string {
  if (type.endsWith('s')) return type;
  if (type.endsWith('y')) return type.slice(0, -1) + 'ies';
  return type + 's';
}

/**
 * Look up the community color for a given node.
 */
export function getCommunityColor(
  communityAssignments: Record<string, number>,
  communityColorMap: Map<number, string>,
  nodeId: string,
): string {
  const communityId = communityAssignments[nodeId];
  if (communityId === undefined) return FALLBACK_COLOR;
  return communityColorMap.get(communityId) ?? FALLBACK_COLOR;
}
