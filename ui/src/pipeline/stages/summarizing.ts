/**
 * Summarization stage: wraps an inner event stream and ensures every
 * node that flows through has a `summary` property.
 *
 * Runs after all other stages, intercepting every event. For each node
 * without a summary, calls the template summarizer. Nodes that already
 * have a summary (e.g. from doc comments) are left unchanged.
 */

import type { PipelineEvent, GraphNode } from '../types';
import { summarizeFromMetadata } from '../../runner/browser/enricher/summarizer/templateSummarizer';
import type { NodeKind } from '../../runner/browser/enricher/summarizer/types';

const TYPE_TO_KIND: Record<string, NodeKind> = {
  Function: 'function',
  Class: 'class',
  File: 'file',
  Directory: 'directory',
};

/** Build a SymbolMetadata object from a graph node's properties. */
function summarizeNode(node: GraphNode): string {
  const kind = TYPE_TO_KIND[node.type];
  if (!kind) {
    // Fallback for Repository, Package, etc.
    return `${node.type} ${node.name}`;
  }

  const props = node.properties ?? {};
  return summarizeFromMetadata({
    name: node.name,
    kind,
    signature: props.signature as string | undefined,
    language: props.language as string | undefined,
    lineCount:
      typeof props.start_line === 'number' && typeof props.end_line === 'number'
        ? props.end_line - props.start_line + 1
        : undefined,
    receiverType: props.receiver_type as string | undefined,
    fileName:
      kind === 'file' ? ((props.path as string) ?? node.name) : undefined,
    childNames: props.childNames as string[] | undefined,
    docs: props.docs as string | undefined,
  });
}

/**
 * Wrap an inner event generator, adding summaries to every node that
 * doesn't already have one. All events are re-yielded with enriched nodes.
 */
export function* execute(
  inner: Generator<PipelineEvent>,
): Generator<PipelineEvent> {
  for (const event of inner) {
    if (event.nodes) {
      for (const node of event.nodes) {
        if (!node.properties?.summary) {
          const summary = summarizeNode(node);
          if (summary) {
            node.properties = { ...node.properties, summary };
          }
        }
      }
    }
    yield event;
  }
}
