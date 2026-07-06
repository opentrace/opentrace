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
 * Pure helpers for the structured `json:review` block emitted by the code
 * review agent. Kept free of React so both UI components and the review
 * runner can share them.
 */

import type { PRReviewComment } from './types';

export interface ReviewData {
  summary: string;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments: PRReviewComment[];
}

export function parseReviewResult(text: string): ReviewData | null {
  // Try ```json:review first, then any ```json block containing review fields
  const patterns = [
    /```json:review\s*\n([\s\S]*?)```/g,
    /```json\s*\n([\s\S]*?)```/g,
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      try {
        const data = JSON.parse(match[1]);
        // Must have summary + verdict to be a review block (not some other JSON)
        if (data.summary && data.verdict) {
          return {
            summary: data.summary,
            verdict: data.verdict,
            comments: Array.isArray(data.comments) ? data.comments : [],
          };
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function stripReviewBlock(text: string): string {
  // Remove ```json:review blocks first, then any ```json block that contains review fields
  let result = text.replace(/```json:review\s*\n[\s\S]*?```/, '');
  // Only strip plain ```json blocks if they contain review structure
  result = result.replace(/```json\s*\n([\s\S]*?)```/g, (full, inner) => {
    try {
      const data = JSON.parse(inner);
      if (data.summary && data.verdict) return '';
    } catch {
      /* not valid JSON, keep it */
    }
    return full;
  });
  return result.trim();
}

/**
 * Downgrade an APPROVE verdict when the agent never inspected some of the
 * PR's changed files — an approval of code it hasn't seen is meaningless.
 * Rewrites the `json:review` block in place (verdict → COMMENT, note
 * appended to the summary); returns the text unchanged for any other
 * verdict or when nothing was skipped.
 */
export function enforceInspectionCoverage(
  text: string,
  uninspectedFiles: string[],
): string {
  if (!uninspectedFiles.length) return text;
  const review = parseReviewResult(text);
  if (!review || review.verdict !== 'APPROVE') return text;

  const shown = uninspectedFiles.slice(0, 10);
  const more = uninspectedFiles.length - shown.length;
  const note =
    ` Note: verdict downgraded from APPROVE — ${uninspectedFiles.length} changed ` +
    `file(s) were not inspected during this review: ${shown.join(', ')}` +
    (more > 0 ? ` (+${more} more)` : '') +
    '.';

  const patched: ReviewData = {
    ...review,
    verdict: 'COMMENT',
    summary: review.summary + note,
  };
  const block = '```json:review\n' + JSON.stringify(patched, null, 2) + '\n```';

  // Replace the existing review block (either fencing style) with the
  // patched one; if the block can't be located, append instead.
  if (/```json:review\s*\n[\s\S]*?```/.test(text)) {
    return text.replace(/```json:review\s*\n[\s\S]*?```/, block);
  }
  let replaced = false;
  const result = text.replace(/```json\s*\n([\s\S]*?)```/g, (full, inner) => {
    if (replaced) return full;
    try {
      const data = JSON.parse(inner);
      if (data.summary && data.verdict) {
        replaced = true;
        return block;
      }
    } catch {
      /* not valid JSON, keep it */
    }
    return full;
  });
  return replaced ? result : text + '\n\n' + block;
}
