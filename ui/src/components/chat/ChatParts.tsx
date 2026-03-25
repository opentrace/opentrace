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

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ChatThought from './ChatThought';
import ChatToolCall from './ChatToolCall';
import { markdownComponents } from './markdownComponents';
import type { MessagePart } from './types';
import type { ReviewData } from './results/ReviewResult';

interface Props {
  parts: MessagePart[];
  streaming?: boolean;
  onNodeSelect?: (nodeId: string) => void;
  onSubmitReview?: (data: ReviewData) => Promise<void>;
  onPostComment?: (number: number, body: string) => Promise<void>;
}

export default function ChatParts({
  parts,
  streaming,
  onNodeSelect,
  onSubmitReview,
  onPostComment,
}: Props) {
  return (
    <>
      {parts.map((part, i) => {
        switch (part.type) {
          case 'thought':
            return <ChatThought key={i} part={part} />;
          case 'tool_call':
            return (
              <ChatToolCall
                key={part.id}
                part={part}
                onNodeSelect={onNodeSelect}
                onSubmitReview={onSubmitReview}
                onPostComment={onPostComment}
              />
            );
          case 'text':
            return (
              <div key={i} className="markdown-body">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {part.content}
                </ReactMarkdown>
                {streaming && i === parts.length - 1 && (
                  <span className="streaming-cursor" />
                )}
              </div>
            );
        }
      })}
    </>
  );
}
