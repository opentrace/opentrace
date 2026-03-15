"""Valid node types for the OpenTrace knowledge graph.

Mirrors the Go ``ValidNodeTypes`` allowlist in ``api/pkg/graph/types.go``
so that databases created by either backend are interoperable.
"""

VALID_NODE_TYPES = {
    "Service",
    "Repo",
    "Repository",
    "Class",
    "Module",
    "Function",
    "File",
    "Directory",
    "Package",
    "Cluster",
    "Namespace",
    "Deployment",
    "InstrumentedService",
    "Span",
    "Log",
    "Metric",
    "Endpoint",
    "Database",
    "DBTable",
}
