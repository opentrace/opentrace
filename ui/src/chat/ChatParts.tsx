import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ChatThought from './ChatThought';
import ChatToolCall from './ChatToolCall';
import { markdownComponents } from './markdownComponents';
import type { MessagePart } from './types';

interface Props {
  parts: MessagePart[];
  streaming?: boolean;
  onNodeSelect?: (nodeId: string) => void;
}

export default function ChatParts({ parts, streaming, onNodeSelect }: Props) {
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
