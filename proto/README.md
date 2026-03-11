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
