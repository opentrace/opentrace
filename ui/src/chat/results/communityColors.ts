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
