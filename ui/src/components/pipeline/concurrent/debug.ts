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

import type { ConcurrentPipelineEvent } from './types';

export interface DebugEntry {
  ts: number;
  elapsed: number;
  label: string;
  detail?: string;
}

/**
 * Ring-buffer debug log for pipeline events.
 *
 * Captures a bounded number of entries with high-resolution timestamps.
 * Designed for diagnostic use — dump to console, expose in a debug panel,
 * or serialize to JSON for bug reports.
 */
export class PipelineDebugLog {
  private entries: DebugEntry[] = [];
  private startTime = 0;
  private readonly maxEntries: number;
  private _enabled: boolean;

  constructor(opts: { maxEntries?: number; enabled?: boolean } = {}) {
    this.maxEntries = opts.maxEntries ?? 2000;
    this._enabled = opts.enabled ?? true;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  start(): void {
    this.entries = [];
    this.startTime = performance.now();
    this.log('pipeline', 'started');
  }

  log(label: string, detail?: string): void {
    if (!this._enabled) return;
    const now = performance.now();
    const entry: DebugEntry = {
      ts: now,
      elapsed: now - this.startTime,
      label,
      detail,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  logEvent(event: ConcurrentPipelineEvent): void {
    if (!this._enabled) return;

    if ('action' in event) {
      const mutInfo = event.mutation
        ? ` nodes=${event.mutation.nodes.length} rels=${event.mutation.relationships.length}`
        : '';
      this.log(
        `stage:${event.stage}`,
        `${event.action} ${event.node}${mutInfo}`,
      );
    } else if ('kind' in event) {
      switch (event.kind) {
        case 'pipeline_done':
          this.log(
            'pipeline',
            `done nodes=${event.totalNodes} rels=${event.totalRelationships}`,
          );
          break;
        case 'pipeline_error':
          this.log('pipeline', `error: ${event.error}`);
          break;
        case 'item_error':
          this.log(
            `stage:${event.stage}`,
            `item_error ${event.node}: ${event.error}`,
          );
          break;
        case 'flush_start':
          this.log(`stage:${event.stage}`, 'flush_start');
          break;
        case 'flush_end': {
          const mutInfo = event.mutation
            ? ` nodes=${event.mutation.nodes.length} rels=${event.mutation.relationships.length}`
            : '';
          this.log(`stage:${event.stage}`, `flush_end${mutInfo}`);
          break;
        }
      }
    }
  }

  /** Return all entries (most recent last). */
  getEntries(): readonly DebugEntry[] {
    return this.entries;
  }

  /** Summarize stage durations and counts. */
  summary(): Record<string, { count: number; totalMs: number }> {
    const stages: Record<
      string,
      { count: number; totalMs: number; lastStart: number }
    > = {};

    for (const entry of this.entries) {
      if (!entry.label.startsWith('stage:')) continue;
      const stage = entry.label;
      if (!stages[stage]) {
        stages[stage] = { count: 0, totalMs: 0, lastStart: 0 };
      }
      if (entry.detail?.startsWith('start ')) {
        stages[stage].lastStart = entry.ts;
      } else if (entry.detail?.startsWith('end ')) {
        if (stages[stage].lastStart > 0) {
          stages[stage].totalMs += entry.ts - stages[stage].lastStart;
          stages[stage].count++;
          stages[stage].lastStart = 0;
        }
      }
    }

    const result: Record<string, { count: number; totalMs: number }> = {};
    for (const [k, v] of Object.entries(stages)) {
      result[k] = {
        count: v.count,
        totalMs: Math.round(v.totalMs * 100) / 100,
      };
    }
    return result;
  }

  /** Dump to console in a readable format. */
  dump(): void {
    console.group('[PipelineDebug] Event log');
    for (const e of this.entries) {
      console.log(
        `%c+${e.elapsed.toFixed(1)}ms%c ${e.label} %c${e.detail ?? ''}`,
        'color: gray',
        'color: white; font-weight: bold',
        'color: cyan',
      );
    }
    console.groupEnd();

    const s = this.summary();
    if (Object.keys(s).length > 0) {
      console.group('[PipelineDebug] Stage summary');
      for (const [stage, info] of Object.entries(s)) {
        console.log(
          `${stage}: ${info.count} items in ${info.totalMs.toFixed(1)}ms (avg ${(info.totalMs / Math.max(info.count, 1)).toFixed(1)}ms)`,
        );
      }
      console.groupEnd();
    }
  }
}
