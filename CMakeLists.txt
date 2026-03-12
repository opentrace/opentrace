cmake_minimum_required(VERSION 3.20)
project(opentrace NONE)

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

# Node / npm — required for UI
find_program(NODE_EXECUTABLE node REQUIRED
    DOC "Node.js runtime (https://nodejs.org)")
find_program(NPM_EXECUTABLE npm REQUIRED
    DOC "npm package manager (https://npmjs.com)")

execute_process(
    COMMAND ${NODE_EXECUTABLE} --version
    OUTPUT_VARIABLE NODE_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)
message(STATUS "Found node: ${NODE_EXECUTABLE} (${NODE_VERSION})")

execute_process(
    COMMAND ${NPM_EXECUTABLE} --version
    OUTPUT_VARIABLE NPM_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)
message(STATUS "Found npm: ${NPM_EXECUTABLE} (${NPM_VERSION})")

# Go — required when api/ is present
if(IS_DIRECTORY "${CMAKE_SOURCE_DIR}/api")
    find_program(GO_EXECUTABLE go REQUIRED
        DOC "Go toolchain (https://go.dev)")
    execute_process(
        COMMAND ${GO_EXECUTABLE} version
        OUTPUT_VARIABLE GO_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)
    message(STATUS "Found go: ${GO_EXECUTABLE} (${GO_VERSION})")
endif()

# Python / uv — required when agent/ is present
if(IS_DIRECTORY "${CMAKE_SOURCE_DIR}/agent")
    find_program(UV_EXECUTABLE uv REQUIRED
        DOC "uv Python package manager (https://github.com/astral-sh/uv)")
    execute_process(
        COMMAND ${UV_EXECUTABLE} --version
        OUTPUT_VARIABLE UV_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)
    message(STATUS "Found uv: ${UV_EXECUTABLE} (${UV_VERSION})")
endif()

# grpc_tools — required for Python proto stub generation
find_program(PYTHON3_EXECUTABLE python3 REQUIRED)
execute_process(
    COMMAND ${PYTHON3_EXECUTABLE} -c "import grpc_tools"
    RESULT_VARIABLE GRPC_TOOLS_RESULT
    ERROR_QUIET)
if(GRPC_TOOLS_RESULT EQUAL 0)
    set(GRPC_TOOLS_AVAILABLE TRUE)
    message(STATUS "Found grpc_tools Python module")
else()
    set(GRPC_TOOLS_AVAILABLE FALSE)
    message(WARNING
        "grpc_tools Python module not found — proto-py target will fail if invoked.\n"
        "Install with:  pip install grpcio-tools\n"
        "or with uv:    uv pip install grpcio-tools")
endif()

# protoc — required for proto code generation
find_program(PROTOC_EXECUTABLE protoc
    DOC "Protocol Buffers compiler (https://protobuf.dev)")
if(PROTOC_EXECUTABLE)
    execute_process(
        COMMAND ${PROTOC_EXECUTABLE} --version
        OUTPUT_VARIABLE PROTOC_VERSION OUTPUT_STRIP_TRAILING_WHITESPACE)
    message(STATUS "Found protoc: ${PROTOC_EXECUTABLE} (${PROTOC_VERSION})")
else()
    message(WARNING
        "protoc not found — proto code generation targets will be unavailable.\n"
        "Install via your package manager, e.g.:\n"
        "  openSUSE:  sudo zypper install protobuf-devel\n"
        "  Debian:    sudo apt install protobuf-compiler\n"
        "  macOS:     brew install protobuf")
endif()

# ---------------------------------------------------------------------------
# Subdirectories
# ---------------------------------------------------------------------------

add_subdirectory(proto)
add_subdirectory(ui)

if(EXISTS "${CMAKE_SOURCE_DIR}/api/CMakeLists.txt")
    set(HAS_API TRUE)
    add_subdirectory(api)
endif()

if(EXISTS "${CMAKE_SOURCE_DIR}/agent/CMakeLists.txt")
    set(HAS_AGENT TRUE)
    add_subdirectory(agent)
endif()

# ---------------------------------------------------------------------------
# Cross-component proto dependencies
#
# proto-ts needs ui-install first (protoc-gen-ts_proto lives in node_modules).
# All build targets that compile generated sources depend on the relevant
# proto target so that code generation runs automatically before compilation.
# ---------------------------------------------------------------------------

add_dependencies(proto-ts ui-install)
add_dependencies(ui-build        proto-ts)
add_dependencies(ui-build-static proto-ts)
add_dependencies(ui-test         proto-ts)
add_dependencies(ui-lint         proto-ts)

if(HAS_API)
    add_dependencies(api-build proto-go)
endif()

if(HAS_AGENT)
    add_dependencies(agent-install proto-py)
    add_dependencies(agent-test    proto-py)
endif()

# ---------------------------------------------------------------------------
# Top-level aggregate targets
# ---------------------------------------------------------------------------

# build — build all available components (proto-all runs first)
if(HAS_API)
    add_custom_target(build DEPENDS proto-all api-build ui-build)
else()
    add_custom_target(build DEPENDS proto-all ui-build)
endif()

# install-deps — install all dependencies
set(_install_deps ui-install)
if(HAS_API)
    list(APPEND _install_deps api-build)   # go build fetches modules
endif()
if(HAS_AGENT)
    list(APPEND _install_deps agent-install)
endif()
add_custom_target(install-deps DEPENDS ${_install_deps})

# test
set(_test_targets ui-test)
if(HAS_API)
    list(APPEND _test_targets api-test)
endif()
if(HAS_AGENT)
    list(APPEND _test_targets agent-test)
endif()
add_custom_target(test DEPENDS ${_test_targets})

# fmt
set(_fmt_targets ui-fmt)
if(HAS_API)
    list(APPEND _fmt_targets api-fmt)
endif()
if(HAS_AGENT)
    list(APPEND _fmt_targets agent-fmt)
endif()
add_custom_target(fmt DEPENDS ${_fmt_targets})

# lint
set(_lint_targets ui-lint)
if(HAS_API)
    list(APPEND _lint_targets api-lint)
endif()
if(HAS_AGENT)
    list(APPEND _lint_targets agent-lint)
endif()
add_custom_target(lint DEPENDS ${_lint_targets})

# clean — remove all build artifacts (CMake clean + component artifacts)
add_custom_target(clean-all
    COMMAND ${CMAKE_COMMAND} --build ${CMAKE_BINARY_DIR} --target clean
    COMMAND ${CMAKE_COMMAND} -E rm -rf
        "${CMAKE_SOURCE_DIR}/ui/dist"
        "${CMAKE_SOURCE_DIR}/ui/node_modules"
    COMMENT "Removing all build artifacts"
)

# proto — generate protobuf code for all languages
add_custom_target(proto DEPENDS proto-all)
