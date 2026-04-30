Explore a component in the OpenTrace knowledge graph.

The user wants to explore: $ARGUMENTS

Use the OpenTrace MCP tools to investigate this component:

1. **Search**: Use `search_graph` with the query "$ARGUMENTS" to find matching nodes. Use `nodeTypes` to narrow if the query implies a type (e.g. service, class, function).
2. **Inspect**: For the best match, use `get_node` with its ID to get full details including all neighbors.
3. **Present**: Show the component's:
   - Type, name, and key properties
   - Immediate relationships (grouped by type)
   - Connected nodes summary

If the component is a File, Class, or Function and has a `path` property, offer to read the source with the `Read` tool.
If it's a Service, show its upstream callers and downstream dependencies using `traverse_graph`.

Keep the output concise but informative — this is a quick exploration, not a deep analysis.
