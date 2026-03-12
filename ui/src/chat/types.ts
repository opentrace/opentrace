/** Structured parts within an assistant message */

export interface TextPart {
  type: 'text';
  content: string;
}

export interface ThoughtPart {
  type: 'thought';
  content: string;
}

export interface ToolCallPart {
  type: 'tool_call';
  id: string;
  name: string;
  args: string;
  result?: string;
  status: 'active' | 'success' | 'error';
  startTime: number;
  endTime?: number;
  /** Progress steps reported by sub-agents while running */
  progressSteps?: string[];
}

export type MessagePart = TextPart | ThoughtPart | ToolCallPart;

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  parts: MessagePart[];
}

export type ChatMessage = UserMessage | AssistantMessage;
