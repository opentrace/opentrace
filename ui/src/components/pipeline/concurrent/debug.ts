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

/** Compact pre-formatted record for a pipeline event. logEvent runs once
 *  per scheduler event (hundreds of thousands of times on a big repo), so
 *  it must not build strings — only the cheap discriminating fields and
 *  mutation LENGTHS are captured here; label/detail strings are
 *  materialized lazily in getEntries()/dump(). Lengths are read eagerly
 *  (two property reads) rather than retaining the mutation itself, which
 *  would pin large node/relationship arrays in the ring after the run. */
interface EventSlot {
  ts: number;
  elapsed: number;
  stage: string;
  /** StageEvent action or pipeline event kind. */
  kind:
    | 'start'
    | 'end'
    | 'pipeline_done'
    | 'pipeline_error'
    | 'item_error'
    | 'flush_start'
    | 'flush_end';
  node?: string;
  error?: string;
  totalNodes?: number;
  totalRelationships?: number;
  /** Mutation lengths, present only when the event carried a mutation. */
  nodesLen?: number;
  relsLen?: number;
}

type RingSlot = DebugEntry | EventSlot;

function isEventSlot(slot: RingSlot): slot is EventSlot {
  return !('label' in slot);
}

/** Materialize the exact label/detail strings the old eager logEvent built. */
function formatEventSlot(slot: EventSlot): DebugEntry {
  const mutInfo =
    slot.nodesLen !== undefined
      ? ` nodes=${slot.nodesLen} rels=${slot.relsLen}`
      : '';
  let label: string;
  let detail: string;
  switch (slot.kind) {
    case 'start':
    case 'end':
      label = `stage:${slot.stage}`;
      detail = `${slot.kind} ${slot.node}${mutInfo}`;
      break;
    case 'pipeline_done':
      label = 'pipeline';
      detail = `done nodes=${slot.totalNodes} rels=${slot.totalRelationships}`;
      break;
    case 'pipeline_error':
      label = 'pipeline';
      detail = `error: ${slot.error}`;
      break;
    case 'item_error':
      label = `stage:${slot.stage}`;
      detail = `item_error ${slot.node}: ${slot.error}`;
      break;
    case 'flush_start':
      label = `stage:${slot.stage}`;
      detail = 'flush_start';
      break;
    case 'flush_end':
      label = `stage:${slot.stage}`;
      detail = `flush_end${mutInfo}`;
      break;
  }
  return { ts: slot.ts, elapsed: slot.elapsed, label, detail };
}

/**
 * Ring-buffer debug log for pipeline events.
 *
 * Captures a bounded number of entries with high-resolution timestamps.
 * Designed for diagnostic use — dump to console, expose in a debug panel,
 * or serialize to JSON for bug reports.
 *
 * The ring is a fixed array with a wrapping write index — the old
 * `entries.shift()` on overflow memmoved the whole buffer once per event,
 * which is real main-thread time at hundreds of thousands of events.
 */
export class PipelineDebugLog {
  private ring: (RingSlot | undefined)[];
  private writeIdx = 0;
  private size = 0;
  private startTime = 0;
  private readonly maxEntries: number;
  private _enabled: boolean;

  constructor(opts: { maxEntries?: number; enabled?: boolean } = {}) {
    this.maxEntries = opts.maxEntries ?? 2000;
    this._enabled = opts.enabled ?? true;
    this.ring = new Array(this.maxEntries);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  start(): void {
    this.ring = new Array(this.maxEntries);
    this.writeIdx = 0;
    this.size = 0;
    this.startTime = performance.now();
    this.log('pipeline', 'started');
  }

  private push(slot: RingSlot): void {
    this.ring[this.writeIdx] = slot;
    this.writeIdx = (this.writeIdx + 1) % this.maxEntries;
    if (this.size < this.maxEntries) this.size++;
  }

  /** Iterate retained slots oldest-first. */
  private *slots(): Generator<RingSlot> {
    const start = this.size < this.maxEntries ? 0 : this.writeIdx; // full ring — oldest is the next overwrite target
    for (let i = 0; i < this.size; i++) {
      const slot = this.ring[(start + i) % this.maxEntries];
      if (slot) yield slot;
    }
  }

  log(label: string, detail?: string): void {
    if (!this._enabled) return;
    const now = performance.now();
    this.push({ ts: now, elapsed: now - this.startTime, label, detail });
  }

  logEvent(event: ConcurrentPipelineEvent): void {
    if (!this._enabled) return;
    const now = performance.now();
    const base = { ts: now, elapsed: now - this.startTime };

    if ('action' in event) {
      this.push({
        ...base,
        stage: event.stage,
        kind: event.action,
        node: event.node,
        ...(event.mutation
          ? {
              nodesLen: event.mutation.nodes.length,
              relsLen: event.mutation.relationships.length,
            }
          : {}),
      });
    } else if ('kind' in event) {
      switch (event.kind) {
        case 'pipeline_done':
          this.push({
            ...base,
            stage: '',
            kind: 'pipeline_done',
            totalNodes: event.totalNodes,
            totalRelationships: event.totalRelationships,
          });
          break;
        case 'pipeline_error':
          this.push({
            ...base,
            stage: '',
            kind: 'pipeline_error',
            error: event.error,
          });
          break;
        case 'item_error':
          this.push({
            ...base,
            stage: event.stage,
            kind: 'item_error',
            node: event.node,
            error: event.error,
          });
          break;
        case 'flush_start':
          this.push({ ...base, stage: event.stage, kind: 'flush_start' });
          break;
        case 'flush_end':
          this.push({
            ...base,
            stage: event.stage,
            kind: 'flush_end',
            ...(event.mutation
              ? {
                  nodesLen: event.mutation.nodes.length,
                  relsLen: event.mutation.relationships.length,
                }
              : {}),
          });
          break;
      }
    }
  }

  /** Return all entries (most recent last). Event slots are formatted
   *  lazily here — this is the rare read path (console dumps, tests). */
  getEntries(): readonly DebugEntry[] {
    const out: DebugEntry[] = [];
    for (const slot of this.slots()) {
      out.push(isEventSlot(slot) ? formatEventSlot(slot) : slot);
    }
    return out;
  }

  /** Summarize stage durations and counts. */
  summary(): Record<string, { count: number; totalMs: number }> {
    const stages: Record<
      string,
      { count: number; totalMs: number; lastStart: number }
    > = {};

    for (const slot of this.slots()) {
      // Only per-node stage events participate in start/end timing —
      // same filter as the old string-prefix checks ('start ' / 'end ')
      // on formatted entries, just on the compact fields.
      let stageName: string;
      let action: 'start' | 'end';
      if (isEventSlot(slot)) {
        if (slot.kind !== 'start' && slot.kind !== 'end') continue;
        stageName = `stage:${slot.stage}`;
        action = slot.kind;
      } else {
        if (!slot.label.startsWith('stage:')) continue;
        if (slot.detail?.startsWith('start ')) action = 'start';
        else if (slot.detail?.startsWith('end ')) action = 'end';
        else continue;
        stageName = slot.label;
      }

      if (!stages[stageName]) {
        stages[stageName] = { count: 0, totalMs: 0, lastStart: 0 };
      }
      if (action === 'start') {
        stages[stageName].lastStart = slot.ts;
      } else if (stages[stageName].lastStart > 0) {
        stages[stageName].totalMs += slot.ts - stages[stageName].lastStart;
        stages[stageName].count++;
        stages[stageName].lastStart = 0;
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
    for (const e of this.getEntries()) {
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
