cmake_minimum_required(VERSION 3.20)

# Use protoc found by the parent; support standalone invocation too.
if(NOT PROTOC_EXECUTABLE)
    find_program(PROTOC_EXECUTABLE protoc)
endif()

set(PROTO_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
set(PROTO_FILES
    "${PROTO_DIR}/opentrace/v1/job_config.proto"
    "${PROTO_DIR}/opentrace/v1/agent_service.proto"
)

set(TS_OUT  "${CMAKE_CURRENT_SOURCE_DIR}/../ui/src/gen")
set(PY_OUT  "${CMAKE_CURRENT_SOURCE_DIR}/../agent/src/opentrace_agent/gen")
set(GO_OUT  "${CMAKE_CURRENT_SOURCE_DIR}/../api")
set(GO_MODULE "github.com/opentrace/opentrace/api")

set(TS_PROTO_PLUGIN "${CMAKE_CURRENT_SOURCE_DIR}/../ui/node_modules/.bin/protoc-gen-ts_proto")

# ---------------------------------------------------------------------------
# proto-ts — generate TypeScript types
# ---------------------------------------------------------------------------
if(PROTOC_EXECUTABLE)
    add_custom_target(proto-ts
        COMMAND ${CMAKE_COMMAND} -E make_directory "${TS_OUT}"
        COMMAND ${PROTOC_EXECUTABLE}
            --proto_path=${PROTO_DIR}
            --plugin=protoc-gen-ts_proto=${TS_PROTO_PLUGIN}
            --ts_proto_out=${TS_OUT}
            --ts_proto_opt=onlyTypes=true
            --ts_proto_opt=enumsAsLiterals=true
            --ts_proto_opt=outputServices=false
            --ts_proto_opt=esModuleInterop=true
            ${PROTO_FILES}
        WORKING_DIRECTORY "${PROTO_DIR}"
        COMMENT "Generating TypeScript protobuf types"
    )
else()
    add_custom_target(proto-ts
        COMMAND ${CMAKE_COMMAND} -E echo "ERROR: protoc is required to generate TypeScript proto types."
        COMMAND ${CMAKE_COMMAND} -E false
        COMMENT "proto-ts unavailable: protoc not found"
    )
endif()

# ---------------------------------------------------------------------------
# proto-py — generate Python stubs
# ---------------------------------------------------------------------------
if(PROTOC_EXECUTABLE AND GRPC_TOOLS_AVAILABLE)
    add_custom_target(proto-py
        COMMAND ${CMAKE_COMMAND} -E make_directory "${PY_OUT}"
        COMMAND python3 -m grpc_tools.protoc
            --proto_path=${PROTO_DIR}
            --python_out=${PY_OUT}
            --pyi_out=${PY_OUT}
            --grpc_python_out=${PY_OUT}
            ${PROTO_FILES}
        # Fix cross-file imports: rewrite proto package path to package path used at runtime
        COMMAND find ${PY_OUT} -name "*.py"  -exec
            sed -i "s/from opentrace\\.v1 import/from opentrace_agent.gen.opentrace.v1 import/g" {} +
        COMMAND find ${PY_OUT} -name "*.pyi" -exec
            sed -i "s/from opentrace\\.v1 import/from opentrace_agent.gen.opentrace.v1 import/g" {} +
        COMMAND ${CMAKE_COMMAND} -E touch "${PY_OUT}/opentrace/__init__.py"
        COMMAND ${CMAKE_COMMAND} -E touch "${PY_OUT}/opentrace/v1/__init__.py"
        WORKING_DIRECTORY "${PROTO_DIR}"
        COMMENT "Generating Python protobuf stubs"
    )
else()
    if(NOT PROTOC_EXECUTABLE)
        set(_proto_py_reason "protoc not found")
    elseif(NOT GRPC_TOOLS_AVAILABLE)
        set(_proto_py_reason "grpc_tools Python module not found (pip install grpcio-tools)")
    endif()
    add_custom_target(proto-py
        COMMAND ${CMAKE_COMMAND} -E echo "ERROR: proto-py unavailable: ${_proto_py_reason}"
        COMMAND ${CMAKE_COMMAND} -E false
        COMMENT "proto-py unavailable: ${_proto_py_reason}"
    )
endif()

# ---------------------------------------------------------------------------
# proto-go — generate Go code
# ---------------------------------------------------------------------------
find_program(GO_EXECUTABLE go)
find_program(PROTOC_GEN_GO      protoc-gen-go)
find_program(PROTOC_GEN_GO_GRPC protoc-gen-go-grpc)

if(PROTOC_EXECUTABLE AND GO_EXECUTABLE AND PROTOC_GEN_GO AND PROTOC_GEN_GO_GRPC)
    add_custom_target(proto-go
        COMMAND ${CMAKE_COMMAND} -E make_directory "${GO_OUT}/pkg/gen/otv1"
        COMMAND ${PROTOC_EXECUTABLE}
            --proto_path=${PROTO_DIR}
            --go_out=${GO_OUT}
            --go_opt=module=${GO_MODULE}
            --go-grpc_out=${GO_OUT}
            --go-grpc_opt=module=${GO_MODULE}
            ${PROTO_FILES}
        WORKING_DIRECTORY "${PROTO_DIR}"
        COMMENT "Generating Go protobuf code"
    )
else()
    if(NOT PROTOC_EXECUTABLE)
        message(STATUS "protoc not found — proto-go target will fail if invoked")
    endif()
    if(NOT PROTOC_GEN_GO)
        message(STATUS "protoc-gen-go not found — proto-go target will fail if invoked")
        message(STATUS "  Install: go install google.golang.org/protobuf/cmd/protoc-gen-go@latest")
    endif()
    if(NOT PROTOC_GEN_GO_GRPC)
        message(STATUS "protoc-gen-go-grpc not found — proto-go target will fail if invoked")
        message(STATUS "  Install: go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest")
    endif()
    add_custom_target(proto-go
        COMMAND ${CMAKE_COMMAND} -E echo
            "ERROR: proto-go requires protoc, protoc-gen-go, and protoc-gen-go-grpc."
        COMMAND ${CMAKE_COMMAND} -E false
        COMMENT "proto-go unavailable: missing protoc or Go plugins"
    )
endif()

# ---------------------------------------------------------------------------
# proto-all — generate for all languages
# ---------------------------------------------------------------------------
add_custom_target(proto-all DEPENDS proto-ts proto-py proto-go)

# ---------------------------------------------------------------------------
# proto-clean
# ---------------------------------------------------------------------------
add_custom_target(proto-clean
    COMMAND ${CMAKE_COMMAND} -E rm -rf "${TS_OUT}" "${PY_OUT}"
    COMMENT "Removing generated proto output"
)
