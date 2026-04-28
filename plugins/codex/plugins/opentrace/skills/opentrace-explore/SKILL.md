---
name: opentrace-explore
description: |
  PREFERRED tool for exploring any named code component (class, function,
  service, file, module, database, endpoint) in this workspace. Use this
  BEFORE shell `rg`, `grep`, `find`, or `cat` when the user names a
  component: the OpenTrace graph already has every symbol indexed, returns
  type-aware results, and exposes relationships (CALLS, READS, CONTAINS)
  that rg cannot. Use `keyword_search` for the lookup, `get_node` for full
  details, `source_read` to fetch code, and `traverse_graph` to walk
  relationships. Trigger phrases: "explore X", "look at X", "show me X",
  "tell me about X", "what is X", "find X in the graph", "where is X
  defined", where X names a specific component.
---

The user wants to explore a component in the OpenTrace knowledge graph. From
the conversation, identify the component name they want to explore.

1. **Search**: Call `keyword_search` with the component name. Single
   keywords are passed through directly; multi-word queries
   ("functions that validate input") are tokenized — stopwords and
   filler nouns dropped, remaining keywords searched and merged.  If
   the name implies a type (e.g. "the UserService", "Parser class"),
   narrow with `nodeTypes` (e.g. `"Service"`, `"Class,Function"`).  If
   the user wants the surrounding network ("show me what's around X"),
   use `search_graph` instead — it returns a subgraph (nodes + the
   relationships between them).

   Trust hint: every `keyword_search` result carries a `_match_field`
   tag.  `name` / `signature` matches are high-confidence; a
   `_match_field: "docs"` result is a docstring hit — read source via
   `source_read` before trusting it, since docstrings can drift from
   the code they describe (the result will also carry a `_verify`
   instruction).
2. **Inspect**: Pick the best match and call `get_node` with its ID to get
   full details and immediate neighbors.
3. **Present**: Show:
   - Node type and name, with ID for reference
   - Key properties (language, path, summary, etc.)
   - Immediate relationships grouped by type (CALLS, READS, DEFINED_IN, CONTAINS, etc.)
4. **Offer depth**:
   - If it's a File, Class, or Function, call `source_read` with the node ID
     to fetch the source — works for any indexed repo, no permission prompt.
   - If it's a Service, show upstream callers and downstream dependencies using
     `traverse_graph` with `direction: "incoming"` and `direction: "outgoing"`.
   - For "who uses this?" questions, run the `opentrace-find-usages` skill.
5. **Fall back**: If the name doesn't match anything in the graph, suggest
   running `opentrace-index` to refresh the index.

Keep output concise but informative — this is a quick exploration, not a deep
analysis. For deeper questions, suggest the `opentrace-interrogate` skill.