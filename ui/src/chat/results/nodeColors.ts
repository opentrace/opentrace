/**
 * Deterministic color assignment for node types.
 * Ported from insight-ui's getGroupColor — uses a fixed palette
 * with DJB2 hash fallback for unknown types.
 */

const PALETTE = [
  '#6366f1', // Indigo
  '#f59e0b', // Amber
  '#10b981', // Emerald
  '#8b5cf6', // Violet
  '#ef4444', // Red
  '#3b82f6', // Blue
  '#ec4899', // Pink
  '#14b8a6', // Teal
  '#f97316', // Orange
  '#84cc16', // Lime
  '#a855f7', // Purple
  '#06b6d4', // Cyan
];

/** Well-known node types → fixed colors for visual consistency */
const KNOWN: Record<string, string> = {
  Service: '#6366f1',
  Database: '#f59e0b',
  DBTable: '#f59e0b',
  Repo: '#10b981',
  Repository: '#10b981',
  Endpoint: '#8b5cf6',
  Cluster: '#ef4444',
  Class: '#3b82f6',
  Module: '#14b8a6',
  Function: '#a855f7',
  File: '#84cc16',
  Directory: '#22d3ee',
  Namespace: '#06b6d4',
  Deployment: '#ec4899',
  Span: '#f97316',
};

function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function getNodeColor(type: string): string {
  return KNOWN[type] ?? PALETTE[djb2(type) % PALETTE.length];
}
