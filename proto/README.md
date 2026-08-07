# Proto

Protobuf definitions for the OpenTrace platform. These are the source of truth for types shared across the Python agent and TypeScript UI.

## Structure

```
opentrace/v1/
  agent_service.proto   — AgentService RPC, job events, indexing types
  job_config.proto      — Git integration config, provider enum
  code_graph.proto      — Graph node/relationship schema (processed by protoc-gen-ladybug)
ladybug/
  options.proto         — protoc-gen-ladybug custom options
```

## Code Generation

```bash
make all    # Generate for all targets (ts, go, graph)
make ts     # TypeScript only  -> ../ui/src/gen/
make go     # Go only          -> ../api/pkg/gen/otv1/
make graph  # Graph schema     -> ../ui/src/gen/ + ../agent/src/opentrace_agent/gen/
make clean  # Remove TS and Python generated code
```

The `graph` target uses [protoc-gen-ladybug](https://github.com/kranklab/protoc-gen-ladybug) to generate LadybugDB schema statements and node type constants from `code_graph.proto`.

There is no Python gRPC-stub target. The agent is local-only and consumes only
the graph schema, which `make graph` emits as part of its Python output.

### Prerequisites

- `protoc` (v3.21+)
- Go: `protoc-gen-go`, `protoc-gen-go-grpc`
- TypeScript: `protoc-gen-ts_proto` (installed via `npm install` in `../ui/`)
- Graph schema: `protoc-gen-ladybug`
