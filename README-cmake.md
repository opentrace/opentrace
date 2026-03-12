# Building with CMake

CMake handles prerequisite checking and Makefile generation for the OpenTrace platform.

## Prerequisites

| Tool | Required for | Install |
|------|-------------|---------|
| CMake ≥ 3.20 | All | [cmake.org](https://cmake.org/download/) |
| Node.js + npm | UI | [nodejs.org](https://nodejs.org) |
| Go | `api/` (when present) | [go.dev](https://go.dev) |
| uv | `agent/` (when present) | [github.com/astral-sh/uv](https://github.com/astral-sh/uv) |
| protoc | Proto code generation | see below |

### Installing protoc

```bash
# openSUSE
sudo zypper install protobuf-devel protoc-gen-go protoc-gen-go-grpc

# Debian / Ubuntu
sudo apt install protobuf-compiler

# macOS
brew install protobuf
```

For Go proto generation, also install the plugins:
```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
```

## Configure

Run CMake once from the repository root to check prerequisites and generate the Makefile:

```bash
cmake -B build .
```

CMake will report found tools and warn about anything missing. The generated Makefile is written to `build/`.

To reconfigure (e.g. after installing a missing tool):
```bash
cmake -B build . --fresh
```

## Building

```bash
# Build all components
cmake --build build

# Build only the UI
cmake --build build --target ui-build

# Build a static UI for Firebase hosting (no API base URL)
cmake --build build --target ui-build-static
```

## Installing dependencies

```bash
# Install all dependencies
cmake --build build --target install-deps

# UI only (re-runs only when package.json changes)
cmake --build build --target ui-install
```

## Testing

```bash
# Run all tests
cmake --build build --target test

# UI tests only
cmake --build build --target ui-test
```

## Formatting and linting

```bash
# Format all source files
cmake --build build --target fmt

# Lint all source files
cmake --build build --target lint

# Individual components
cmake --build build --target ui-fmt
cmake --build build --target ui-lint
```

## Proto code generation

Requires `protoc` (see Prerequisites above).

```bash
# Generate for all languages (TypeScript, Python, Go)
cmake --build build --target proto-all

# Individual languages
cmake --build build --target proto-ts
cmake --build build --target proto-py
cmake --build build --target proto-go
```

## Running development servers

These targets are not part of the default build — invoke them directly:

```bash
cmake --build build --target ui-dev      # Vite dev server (port 5173)
cmake --build build --target ui-preview  # Preview production build
```

## Cleaning

```bash
# Remove generated proto output
cmake --build build --target proto-clean

# Remove UI dist/ and node_modules/
cmake --build build --target ui-clean

# Remove everything including the build/ directory itself
cmake --build build --target clean-all
rm -rf build/
```

## Available targets

| Target | Description |
|--------|-------------|
| `build` (default) | Build all components |
| `install-deps` | Install all dependencies |
| `test` | Run all tests |
| `fmt` | Format all source files |
| `lint` | Lint all source files |
| `proto-all` | Generate proto code for TS, Python, and Go |
| `proto-ts` | Generate TypeScript proto types |
| `proto-py` | Generate Python proto stubs |
| `proto-go` | Generate Go proto code |
| `proto-clean` | Remove generated proto output |
| `ui-install` | Install npm dependencies |
| `ui-build` | Build the UI |
| `ui-build-static` | Build static UI (browser-only, for Firebase) |
| `ui-dev` | Start Vite development server |
| `ui-preview` | Start Vite preview server |
| `ui-test` | Run UI tests |
| `ui-fmt` | Format UI source files |
| `ui-lint` | Lint UI source files |
| `ui-clean` | Remove UI dist/ and node_modules/ |
| `clean-all` | Remove all build artifacts |
