cmake_minimum_required(VERSION 3.20)
project(user_service C)

set(CMAKE_C_STANDARD 11)

find_package(PkgConfig REQUIRED)
pkg_check_modules(MICROHTTPD REQUIRED libmicrohttpd)
pkg_check_modules(SQLITE3 REQUIRED sqlite3)

add_executable(user_service main.c db.c)
target_include_directories(user_service PRIVATE
    ${MICROHTTPD_INCLUDE_DIRS}
    ${SQLITE3_INCLUDE_DIRS}
)
target_link_libraries(user_service
    ${MICROHTTPD_LIBRARIES}
    ${SQLITE3_LIBRARIES}
)
