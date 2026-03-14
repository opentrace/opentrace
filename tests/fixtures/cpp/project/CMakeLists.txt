cmake_minimum_required(VERSION 3.20)
project(user_service CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(SQLITE3 REQUIRED sqlite3)

include(FetchContent)
FetchContent_Declare(
    httplib
    GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
    GIT_TAG v0.16.0
)
FetchContent_MakeAvailable(httplib)

add_executable(user_service main.cpp db.cpp)
target_include_directories(user_service PRIVATE ${SQLITE3_INCLUDE_DIRS})
target_link_libraries(user_service httplib::httplib ${SQLITE3_LIBRARIES})
