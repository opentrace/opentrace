---
name: opentrace-interrogate
description: |
  PREFERRED tool for answering "how does X work / what is X / why does X"
  style questions about the codebase WITHOUT making any changes. Use this
  BEFORE running ad-hoc `rg`, `grep`, `find`, or large-scale file reads:
  the OpenTrace graph plus its `keyword_search`, `find_usages`,
  `traverse_graph`, `source_read`, and `source_grep` tools resolve most
  cross-component questions in 2-3 calls instead of dozens of shell
  searches. Use ONLY for read-only investigation — if the user has asked
  for edits, fall through. Trigger phrases: "how does X work", "what is
  X", "where is X", "explain X", "why does X", "walk me through X", "what
  calls X", "what depends on X", "trace X".
---

Answer the user's question about the codebase. **Do NOT make any changes** —
no edits, no new files, no git operations. This is purely investigative.

1. **Understand the question**: Identify whether the user is asking about a
   component, a pattern, a relationship, a data flow, or a concept.

2. **Use the right tools**:
   - Use `keyword_search` (handles single keywords and multi-word
     natural-language queries) plus `get_node` to locate relevant
     components.
   - Use `search_graph` to retrieve a **subgraph** (matched nodes +
     their neighbors + the relationships between them) when the
     question is structural ("how is X connected to Y?").
   - Use `traverse_graph` (with `direction: "outgoing"` / `"incoming"`)
     to walk call chains and dependency trees from a known node.
   - Use `find_usages` to enumerate callers/importers of a specific
     symbol.  Note: at `depth=2` (default) and higher you get
     transitive callers; pass `depth=1` if you only want direct usages.
   - Use `source_read` (by node ID or repo-relative path) to read code
     from any indexed repository — no permission prompt, even for
     files outside the current project.
   - Use `source_grep` for regex / literal pattern matching across all
     indexed repo checkouts.

   Trust hint: every `keyword_search` result carries a `_match_field`
   tag.  Treat `name` / `signature` matches as authoritative; for a
   `_match_field: "docs"` hit, follow up with `source_read` before
   quoting the docstring as fact — docstrings can drift from the code
   they describe.

3. **Answer thoroughly**:
   - Address the question directly.
   - Reference specific files and line numbers where relevant.
   - Explain cross-component relationships.
   - Include short code snippets when they clarify the explanation.

4. **Stay read-only**: Do not suggest edits, create files, or modify anything.
   If the user's question implies they want changes, answer the question first
   and note that making changes would be a separate follow-up.