/**
 * Resolving stage: call resolution.
 *
 * Import analysis has already been performed per-file in the processing stage.
 * This stage only resolves calls using the 7-strategy resolver.
 *
 * Produces CALLS relationships.
 */

import type { ProcessingOutput, PipelineEvent, PipelineResult } from '../types';
import {
  resolveCalls,
  resolvedCallsToRelationships,
} from '../../runner/browser/parser/callResolver';

export function* execute(
  input: ProcessingOutput,
): Generator<PipelineEvent, PipelineResult> {
  const { registries, allCallInfo, stats } = input;

  yield {
    kind: 'stage_start',
    phase: 'resolving',
    message: `Resolving ${allCallInfo.length} call sites`,
  };

  const resolvedCalls = resolveCalls(allCallInfo, registries);
  const callRels = resolvedCallsToRelationships(resolvedCalls);

  if (callRels.length > 0) {
    yield {
      kind: 'stage_progress',
      phase: 'resolving',
      message: `Resolved ${callRels.length} calls`,
      relationships: callRels,
    };
  }

  yield {
    kind: 'stage_stop',
    phase: 'resolving',
    message: `Resolved ${callRels.length} calls`,
  };

  return {
    nodesCreated: stats.nodesCreated,
    relationshipsCreated: stats.relationshipsCreated + callRels.length,
    filesProcessed: stats.filesProcessed,
    classesExtracted: stats.classesExtracted,
    functionsExtracted: stats.functionsExtracted,
  };
}
