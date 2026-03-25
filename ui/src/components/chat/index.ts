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

// ─── Side-effect CSS imports (bundled into the chunk) ────────────────────
import './markdown.css';
import './parts.css';
import './MermaidDiagram.css';
import './results/results.css';
import './results/ReviewResult.css';
import './results/SuggestCommentResult.css';

// ─── Types ───────────────────────────────────────────────────────────────
export type {
  TextPart,
  ThoughtPart,
  ToolCallPart,
  MessagePart,
  UserMessage,
  AssistantMessage,
  ChatMessage,
  PRReviewComment,
} from './types';

// ─── Components ──────────────────────────────────────────────────────────
export { default as ChatParts } from './ChatParts';
export { default as ChatThought } from './ChatThought';
export { default as ChatToolCall } from './ChatToolCall';
export { default as ChatTemplates } from './ChatTemplates';
export { markdownComponents } from './markdownComponents';
export { default as MermaidDiagram } from './MermaidDiagram';

// ─── Result components ───────────────────────────────────────────────────
export { default as NodeListResult } from './results/NodeListResult';
export { default as GetNodeResult } from './results/GetNodeResult';
export { default as TraverseResult } from './results/TraverseResult';
export {
  default as ReviewResult,
  parseReviewResult,
  stripReviewBlock,
  type ReviewData,
} from './results/ReviewResult';
export {
  default as SuggestCommentResult,
  parseSuggestComment,
  type SuggestCommentData,
} from './results/SuggestCommentResult';

// ─── Parsers ─────────────────────────────────────────────────────────────
export {
  parseSearchResult,
  parseListNodesResult,
  parseGetNodeResult,
  parseTraverseResult,
  extractNodeIds,
  type NodeResult,
  type TraverseRelationship,
  type TraverseEntry,
} from './results/parsers';
