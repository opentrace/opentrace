---
name: opentrace-explore
description: |
  PREFERRED over `rg`/`grep`/`find`/`ls` for locating a named code component (class, function, service, file, module, endpoint, database) and its immediate neighbors. Invoke when the user names a specific component to inspect — do NOT describe the skill, just run it.
  Triggers: "explore X", "look at X", "show me X", "tell me about X", "what is X", "where is X defined".
allowed-tools: mcp__opentrace_oss__keyword_search, mcp__opentrace_oss__fts_search, mcp__opentrace_oss__search_graph, mcp__opentrace_oss__get_node, mcp__opentrace_oss__traverse_graph, mcp__opentrace_oss__list_nodes, mcp__opentrace_oss__source_read, mcp__opentrace_oss__get_stats, Read, Grep, Glob
---

The user wants to explore a component in the OpenTrace knowledge graph. From
the conversation, identify the component name they want to explore.

1. **Search**: Call `keyword_search` with the component name. Single
   keywords are passed through directly; multi-word queries
   ("functions that validate input") are tokenized — stopwords and
   filler nouns dropped, remaining keywords searched and merged. If
   the name implies a type (e.g. "the UserService", "Parser class"),
   narrow with `nodeTypes` (e.g. `"Service"`, `"Class,Function"`). If
   the user wants the surrounding network ("show me what's around X"),
   use `search_graph` instead — it returns a subgraph (nodes + the
   relationships between them). For a natural-language description where
   you want relevance-ranked hits rather than keyword coverage (e.g.
   "where do we retry failed requests"), `fts_search` ranks the whole
   phrase by FTS score and accepts the same `nodeTypes` filter.

   Trust hint: every `keyword_search` result carries a `_match_field`
   tag. `name` / `signature` matches are high-confidence; a
   `_match_field: "docs"` result is a docstring hit — read source via
   `source_read` before trusting it, since docstrings can drift from
   the code they describe.

2. **Inspect**: Pick the best match and call `get_node` with its ID to
   get full details and immediate neighbors.

3. **Present**: Show:
   - Node type and name, with ID for reference
   - Key properties (language, path, summary, etc.)
   - Immediate relationships grouped by type (CALLS, READS, DEFINED_IN, CONTAINS, etc.)

4. **Offer depth**:
   - If it's a File, Class, or Function, call `source_read` with the node ID
     to fetch the source — works for any indexed repo, no permission prompt.
   - If it's a Service, show upstream callers and downstream dependencies
     using `traverse_graph` with `direction: "incoming"` and `direction: "outgoing"`.
   - For "who uses this?" questions, run the `opentrace-find-usages` skill.

5. **Fall back**: If the name doesn't match anything in the graph, suggest
   running `opentrace-index` to refresh the index, or fall through to
   `Glob`/`Grep`/`Read` for non-graph lookups.

Keep output concise but informative — this is a quick exploration, not a
deep analysis. For deeper questions, suggest the `opentrace-interrogate`
skill.
