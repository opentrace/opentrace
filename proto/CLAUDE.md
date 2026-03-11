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
make all   # Generate for all targets (ts, py, go)
make ts    # TypeScript only  -> ../ui/src/gen/
make py    # Python only      -> ../agent/src/opentrace_agent/gen/
make go    # Go only          -> ../api/pkg/gen/otv1/
make clean # Remove TS and Python generated code
```

### Prerequisites

- `protoc` (v3.21+)
- Go: `protoc-gen-go`, `protoc-gen-go-grpc`
- Python: `grpcio-tools` (`python -m grpc_tools.protoc`)
- TypeScript: `protoc-gen-ts_proto` (installed via `npm install` in `../ui/`)

### TypeScript Options

The TS target uses `protoc-gen-ts_proto` with these options:

| Option | Purpose |
|--------|---------|
| `onlyTypes=true` | Generate interfaces and types only, no runtime marshalling code |
| `enumsAsLiterals=true` | Emit `as const` objects instead of `enum` declarations (required for `erasableSyntaxOnly` in tsconfig) |
| `outputServices=false` | Suppress gRPC service stubs (UI uses HTTP/SSE, not gRPC directly) |
| `esModuleInterop=true` | Use ES module import style |

### Python Post-Processing

The Python target patches cross-file imports after generation because `protoc` uses the proto package path (`opentrace.v1`) but the files live under `opentrace_agent.gen.opentrace.v1`.

## Services

### AgentService

Server-streaming RPC for indexing jobs:

```protobuf
service AgentService {
  rpc RunJob(RunJobRequest) returns (stream JobEvent);
}
```

The Go API server acts as gRPC client, calling the Python agent which implements `AgentService`. Job progress streams back as `JobEvent` messages.
