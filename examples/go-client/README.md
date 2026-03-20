# Go Client Example

Demonstrates how to build an OpenTrace knowledge graph from Go code and load it into a running OpenTrace instance.

## What it does

Models a small Go microservice (`user-service`) as a graph of:
- **Repository** — the project root
- **Directories** — `cmd/server`, `internal/handler`, `internal/model`, `internal/repo`
- **Files** — `.go` source files
- **Classes** — Go structs (`Handler`, `User`, `UserRepo`)
- **Functions** — Go functions and methods (`main`, `Handler.ListUsers`, `UserRepo.FindAll`, etc.)
- **Packages** — external dependencies (`gin`, `gorm`)
- **Relationships** — `DEFINED_IN`, `CALLS`, `IMPORTS`, `DEPENDS_ON`

## Usage

```bash
# Print the graph as JSON (no server needed)
go run . --print

# Load into a running OpenTrace instance
go run . --url http://localhost:5173
```

## Graph schema

See the `graph/` package for the types and builder API:

```go
import "github.com/opentrace/opentrace/examples/go-client/graph"

b := graph.NewBuilder("myorg", "myapp")

// Add files (auto-creates directory chain)
fileID := b.AddFile("internal/handler/handler.go", "go", map[string]any{
    "summary": "HTTP request handlers",
})

// Add symbols
funcID := b.AddFunction(fileID, "HandleRequest", 10, 25, map[string]any{
    "language":  "go",
    "signature": "func HandleRequest(w http.ResponseWriter, r *http.Request)",
})

// Add Go methods (with receiver type in the ID)
methodID := b.AddGoMethod(fileID, "Server", "Start", 30, 45, map[string]any{
    "signature": "(s *Server) Start(addr string) error",
})

// Add relationships
b.AddCall(funcID, methodID, 1.0)
b.AddImport(fileID, otherFileID)

// Add packages
pkgID := b.AddPackage("go", "github.com/gin-gonic/gin", "v1.10.0")

// Build the batch
batch := b.Build()
```

## Node ID conventions

| Node type | ID format | Example |
|---|---|---|
| Repository | `owner/repo` | `example/user-service` |
| Directory | `owner/repo/path` | `example/user-service/internal/handler` |
| File | `owner/repo/path/file` | `example/user-service/main.go` |
| Class/Struct | `fileID::Name` | `example/user-service/model.go::User` |
| Function | `fileID::name` | `example/user-service/main.go::main` |
| Go method | `fileID::Type.method` | `example/user-service/handler.go::Handler.ListUsers` |
| Package | `pkg:registry:name` | `pkg:go:github.com/gin-gonic/gin` |

## Loading via HTTP API

The `graph.Client` sends batches to the OpenTrace import endpoint:

```go
client := graph.NewClient("http://localhost:5173")
result, err := client.ImportBatch(ctx, batch)
// result.NodesCreated, result.RelationshipsCreated

// Query
nodes, _ := client.SearchNodes(ctx, "handler", 10, nil)
stats, _ := client.GetStats(ctx)
```
