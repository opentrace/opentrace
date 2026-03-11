import { useMemo } from "react";
import type { ToolCallPart } from "./types";
import {
  parseSearchResult,
  parseListNodesResult,
  parseGetNodeResult,
  parseTraverseResult,
} from "./results/parsers";
import NodeListResult from "./results/NodeListResult";
import GetNodeResultView from "./results/GetNodeResult";
import TraverseResultView from "./results/TraverseResult";
import "./results/results.css";

interface Props {
  part: ToolCallPart;
}

/** User-friendly tool names */
const TOOL_NAMES: Record<string, string> = {
  search_graph: "Search Graph",
  list_nodes: "List Nodes",
  get_node: "Get Node",
  traverse_graph: "Traverse Graph",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const RAW_DISPLAY_LIMIT = 2000;

function tryPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

/** Renders raw JSON as a fallback when custom parsing fails */
function RawResult({ result }: { result: string }) {
  const pretty = tryPrettyJson(result);
  const truncated = pretty.length > RAW_DISPLAY_LIMIT;
  const display = truncated
    ? pretty.slice(0, RAW_DISPLAY_LIMIT) + "\n\u2026[truncated]"
    : pretty;

  return <pre className="tool-section-content">{display}</pre>;
}

export default function ChatToolCall({ part }: Props) {
  const displayName = TOOL_NAMES[part.name] ?? part.name;
  const duration = part.endTime ? formatDuration(part.endTime - part.startTime) : null;
  const prettyArgs = part.args ? tryPrettyJson(part.args) : "";

  // Attempt structured parsing per tool type
  const customResult = useMemo(() => {
    if (!part.result || part.status === "error") return null;

    switch (part.name) {
      case "search_graph": {
        const nodes = parseSearchResult(part.result);
        return nodes ? <NodeListResult nodes={nodes} /> : null;
      }
      case "list_nodes": {
        const nodes = parseListNodesResult(part.result);
        return nodes ? <NodeListResult nodes={nodes} /> : null;
      }
      case "get_node": {
        const node = parseGetNodeResult(part.result);
        return node ? <GetNodeResultView node={node} /> : null;
      }
      case "traverse_graph": {
        const entries = parseTraverseResult(part.result);
        return entries ? <TraverseResultView entries={entries} /> : null;
      }
      default:
        return null;
    }
  }, [part.name, part.result, part.status]);

  return (
    <details className="chat-tool-call" open={part.status === "active"}>
      <summary className="tool-call-summary">
        <svg className="tool-call-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
        <span className="tool-call-name">{displayName}</span>
        {part.status === "active" && (
          <span className="tool-status-badge active">
            <span className="tool-status-spinner" />
            Running
          </span>
        )}
        {part.status === "success" && (
          <span className="tool-status-badge success">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Done
          </span>
        )}
        {part.status === "error" && (
          <span className="tool-status-badge error">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Error
          </span>
        )}
        {duration && <span className="tool-duration">{duration}</span>}
      </summary>
      <div className="tool-call-details">
        {prettyArgs && (
          <details className="tool-section">
            <summary className="tool-section-label">Arguments</summary>
            <pre className="tool-section-content">{prettyArgs}</pre>
          </details>
        )}
        {part.result && (
          <details className="tool-section" open={!!customResult}>
            <summary className="tool-section-label">
              Result
              {!customResult && part.result.length > 500 && (
                <span className="tool-size-hint">{formatSize(part.result.length)}</span>
              )}
            </summary>
            <div className={customResult ? "tool-section-custom" : ""}>
              {customResult ?? <RawResult result={part.result} />}
            </div>
          </details>
        )}
      </div>
    </details>
  );
}
