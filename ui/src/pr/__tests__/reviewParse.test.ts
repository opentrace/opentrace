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

import { describe, it, expect } from 'vitest';
import {
  parseReviewResult,
  stripReviewBlock,
  enforceInspectionCoverage,
} from '../reviewParse';

function reviewText(verdict: string, summary = 'Looks good.'): string {
  return (
    'Prose review here.\n\n```json:review\n' +
    JSON.stringify({ summary, verdict, comments: [] }, null, 2) +
    '\n```'
  );
}

describe('parseReviewResult', () => {
  it('parses a json:review block', () => {
    const data = parseReviewResult(reviewText('APPROVE'));
    expect(data).not.toBeNull();
    expect(data!.verdict).toBe('APPROVE');
    expect(data!.summary).toBe('Looks good.');
  });

  it('returns null when no review block exists', () => {
    expect(parseReviewResult('just prose')).toBeNull();
  });
});

describe('stripReviewBlock', () => {
  it('removes the review block but keeps prose', () => {
    const stripped = stripReviewBlock(reviewText('COMMENT'));
    expect(stripped).toBe('Prose review here.');
  });
});

describe('enforceInspectionCoverage', () => {
  it('downgrades APPROVE when files were not inspected', () => {
    const result = enforceInspectionCoverage(reviewText('APPROVE'), [
      'src/a.ts',
      'src/b.ts',
    ]);
    const data = parseReviewResult(result)!;
    expect(data.verdict).toBe('COMMENT');
    expect(data.summary).toContain('downgraded from APPROVE');
    expect(data.summary).toContain('src/a.ts');
  });

  it('leaves APPROVE untouched when everything was inspected', () => {
    const text = reviewText('APPROVE');
    expect(enforceInspectionCoverage(text, [])).toBe(text);
  });

  it('leaves non-APPROVE verdicts untouched', () => {
    const text = reviewText('REQUEST_CHANGES');
    expect(enforceInspectionCoverage(text, ['src/a.ts'])).toBe(text);
  });

  it('handles plain json fencing', () => {
    const text =
      '```json\n' +
      JSON.stringify({ summary: 'ok', verdict: 'APPROVE', comments: [] }) +
      '\n```';
    const result = enforceInspectionCoverage(text, ['x.ts']);
    expect(parseReviewResult(result)!.verdict).toBe('COMMENT');
  });

  it('caps the listed files at 10 with a +N more suffix', () => {
    const files = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
    const result = enforceInspectionCoverage(reviewText('APPROVE'), files);
    const data = parseReviewResult(result)!;
    expect(data.summary).toContain('(+4 more)');
  });
});
