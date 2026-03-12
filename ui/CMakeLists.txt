cmake_minimum_required(VERSION 3.20)

# Use variables set by the parent; support standalone invocation too.
if(NOT NPM_EXECUTABLE)
    find_program(NPM_EXECUTABLE npm REQUIRED)
endif()

set(UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
set(UI_STAMP "${CMAKE_CURRENT_BINARY_DIR}/npm_install.stamp")

# ---------------------------------------------------------------------------
# ui-install — npm install (re-runs only when package.json changes)
# ---------------------------------------------------------------------------
add_custom_command(
    OUTPUT  "${UI_STAMP}"
    COMMAND ${NPM_EXECUTABLE} install
    COMMAND ${CMAKE_COMMAND} -E touch "${UI_STAMP}"
    WORKING_DIRECTORY "${UI_DIR}"
    DEPENDS "${UI_DIR}/package.json"
    COMMENT "Installing UI npm dependencies"
)
add_custom_target(ui-install DEPENDS "${UI_STAMP}")

# ---------------------------------------------------------------------------
# ui-build — tsc + vite build (depends on install)
# ---------------------------------------------------------------------------
add_custom_target(ui-build
    COMMAND ${NPM_EXECUTABLE} run build
    WORKING_DIRECTORY "${UI_DIR}"
    DEPENDS "${UI_STAMP}"
    COMMENT "Building UI (tsc + vite)"
)

# ---------------------------------------------------------------------------
# ui-build-static — browser-only static build (used for Firebase hosting)
# ---------------------------------------------------------------------------
add_custom_target(ui-build-static
    COMMAND ${CMAKE_COMMAND} -E env
        VITE_API_BASE=""
        VITE_BROWSER_ONLY=true
        ${NPM_EXECUTABLE} run build
    WORKING_DIRECTORY "${UI_DIR}"
    DEPENDS "${UI_STAMP}"
    COMMENT "Building static UI (browser-only, no API base URL)"
)

# ---------------------------------------------------------------------------
# Development / preview
# ---------------------------------------------------------------------------
add_custom_target(ui-dev
    COMMAND ${NPM_EXECUTABLE} run dev
    WORKING_DIRECTORY "${UI_DIR}"
    COMMENT "Starting UI development server"
)

add_custom_target(ui-preview
    COMMAND ${NPM_EXECUTABLE} run preview
    WORKING_DIRECTORY "${UI_DIR}"
    COMMENT "Starting UI preview server"
)

# ---------------------------------------------------------------------------
# Test / lint / fmt
# ---------------------------------------------------------------------------
add_custom_target(ui-test
    COMMAND ${NPM_EXECUTABLE} test
    WORKING_DIRECTORY "${UI_DIR}"
    DEPENDS "${UI_STAMP}"
    COMMENT "Running UI tests"
)

add_custom_target(ui-fmt
    COMMAND ${NPM_EXECUTABLE} run fmt
    WORKING_DIRECTORY "${UI_DIR}"
    DEPENDS "${UI_STAMP}"
    COMMENT "Formatting UI source files"
)

add_custom_target(ui-lint
    COMMAND ${NPM_EXECUTABLE} run lint
    WORKING_DIRECTORY "${UI_DIR}"
    DEPENDS "${UI_STAMP}"
    COMMENT "Linting UI source files"
)

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------
add_custom_target(ui-clean
    COMMAND ${CMAKE_COMMAND} -E rm -rf
        "${UI_DIR}/dist"
        "${UI_DIR}/node_modules"
        "${UI_STAMP}"
    COMMENT "Cleaning UI build artifacts and node_modules"
)
