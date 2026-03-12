import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownComponents } from './markdownComponents';
import type { ThoughtPart } from './types';

interface Props {
  part: ThoughtPart;
}

/** Strip markdown syntax for a compact preview */
function stripMarkdown(text: string): string {
  return text
    .replace(/[#*_`~>\[\]()!|-]/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

export default function ChatThought({ part }: Props) {
  const preview = stripMarkdown(part.content).slice(0, 80);

  return (
    <details className="chat-thought">
      <summary className="thought-summary">
        <svg
          className="thought-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2a6 6 0 0 0-6 6c0 1.66.68 3.16 1.76 4.24L9 13.5V16h6v-2.5l1.24-1.26A6 6 0 0 0 12 2z" />
          <path d="M10 20h4" />
          <path d="M10 23h4" />
        </svg>
        <span className="thought-label">Thought</span>
        <span className="thought-preview">
          {preview}
          {part.content.length > 80 ? '\u2026' : ''}
        </span>
      </summary>
      <div className="thought-content markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {part.content}
        </ReactMarkdown>
      </div>
    </details>
  );
}
