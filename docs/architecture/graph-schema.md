# Graph Schema

## Node Types

OpenTrace builds a knowledge graph with the following node types:

| Node Type | Description |
|-----------|-------------|
| `Service` | A deployed service or application |
| `Repo` / `Repository` | A source code repository |
| `Class` | A class definition |
| `Module` | A module or package |
| `Function` | A function or method |
| `File` | A source file |
| `Directory` | A directory in the repository |
| `Cluster` | An infrastructure cluster |
| `Namespace` | A Kubernetes namespace or similar grouping |
| `Deployment` | A deployment configuration |
| `InstrumentedService` | A service with observability instrumentation |
| `Span` | A distributed trace span |
| `Log` | A log entry |
| `Metric` | A metric definition |
| `Endpoint` | An API endpoint |
| `Database` | A database instance |
| `DBTable` | A database table |

## Relationships

Nodes are connected through relationships that represent:

- **Code structure** — files contain classes, classes contain functions
- **Dependencies** — imports, function calls, service-to-service calls
- **Infrastructure** — deployments in namespaces, services in clusters
