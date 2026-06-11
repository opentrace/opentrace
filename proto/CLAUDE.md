# Proto

Protobuf definitions for the OpenTrace platform. These are the source of truth for types shared across the Go API, Python agent, and TypeScript UI.

## Structure

```
opentrace/v1/
  agent_service.proto   — AgentService RPC, job events, indexing types
  job_config.proto      — Git integration config, provider enum
```

## Code Generation

```bash
make all   # Generate for all targets (ts, go, graph)
make ts    # TypeScript only  -> ../ui/src/gen/
make go    # Go only          -> ../api/pkg/gen/otv1/
make graph # LadybugDB graph schema (Python + TS) -> ../agent/src/opentrace_agent/gen/ + ../ui/src/gen/
make clean # Remove TS and Python generated code
```

The Python `make py` target was retired when the agent went local-only —
the agent no longer consumes the gRPC stubs. If a future change reintroduces
a Python gRPC consumer, restore the `py:` target (and `grpcio-tools` in
`agent/pyproject.toml [dependency-groups] dev`).

### Prerequisites

- `protoc` (v3.21+)
- Go: `protoc-gen-go`, `protoc-gen-go-grpc`
- TypeScript: `protoc-gen-ts_proto` (installed via `npm install` in `../ui/`)
- Graph schema: `protoc-gen-ladybug` (LadybugDB schema generator)

### TypeScript Options

The TS target uses `protoc-gen-ts_proto` with these options:

| Option | Purpose |
|--------|---------|
| `onlyTypes=true` | Generate interfaces and types only, no runtime marshalling code |
| `enumsAsLiterals=true` | Emit `as const` objects instead of `enum` declarations (required for `erasableSyntaxOnly` in tsconfig) |
| `outputServices=false` | Suppress gRPC service stubs (UI uses HTTP/SSE, not gRPC directly) |
| `esModuleInterop=true` | Use ES module import style |

## Services

### AgentService

Server-streaming RPC for indexing jobs:

```protobuf
service AgentService {
  rpc RunJob(RunJobRequest) returns (stream JobEvent);
}
```

Currently consumed by the UI (TypeScript types only) and the Go API. The
Python agent is local-only and does not implement the gRPC service today;
see the note above about restoring the `py:` target if that changes.
