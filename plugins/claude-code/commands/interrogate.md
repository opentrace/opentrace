---
name: interrogate
description: |
  Answer a question about the codebase without making any changes.
  Use when: "how does X work", "what is X", "where is X", "explain X", "why does X"
allowed-tools: Read, Glob, Grep, mcp__opentrace_oss__search_graph, mcp__opentrace_oss__get_node, mcp__opentrace_oss__traverse_graph, mcp__opentrace_oss__list_nodes, mcp__opentrace_oss__get_stats
---

Answer the user's question about the codebase. **Do NOT make any changes** — no edits, no new files, no git operations. This is purely investigative.

Question: $ARGUMENTS

## Instructions

1. **Understand the question**: Determine what the user is asking about — a component, pattern, relationship, flow, or concept.

2. **Use the right tools**: Combine OpenTrace graph tools with direct file reading to build a complete answer:
   - Use `search_graph` and `get_node` to find relevant components and their relationships
   - Use `traverse_graph` to map dependencies and call chains
   - Use `Read`, `Glob`, and `Grep` to inspect actual source code when needed
   - Cross-reference graph knowledge with source code for accuracy

3. **Answer thoroughly**: Provide a clear, well-structured answer that:
   - Directly addresses the question
   - References specific files and line numbers where relevant
   - Explains relationships between components if applicable
   - Includes short code snippets when they clarify the explanation

4. **Stay read-only**: Do not suggest changes, create files, or modify anything. If the user's question implies they want changes, answer the question first and note that changes would need to be done separately.
