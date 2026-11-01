cmake_minimum_required(VERSION 3.22.1)
project(splayer LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
get_filename_component(SPLAYER_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../.." ABSOLUTE)
set(SPLAYER_NODE "${SPLAYER_ROOT}/android/vendor/node")
include("${SPLAYER_ROOT}/android/vendor/sqlite.cmake")
# 运行时升级必须重新编译桥接，归档内的头文件时间可能早于旧对象文件
set_source_files_properties(bridge.cpp "${SPLAYER_SQLITE_ROOT}/src/better_sqlite3.cpp"
    PROPERTIES OBJECT_DEPENDS "${SPLAYER_NODE}/.version")

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION "${SPLAYER_NODE}/bin/${ANDROID_ABI}/libnode.so")

add_library(sqlite STATIC "${SPLAYER_SQLITE_ROOT}/deps/sqlite3/sqlite3.c")
target_compile_definitions(sqlite PRIVATE ${SPLAYER_SQLITE_DEFINES})
target_include_directories(sqlite PUBLIC "${SPLAYER_SQLITE_ROOT}/deps/sqlite3")

add_library(better_sqlite3 SHARED "${SPLAYER_SQLITE_ROOT}/src/better_sqlite3.cpp")
target_include_directories(better_sqlite3 PRIVATE "${SPLAYER_NODE}/include/node" "${SPLAYER_NODE_ADDON}")
target_compile_definitions(better_sqlite3 PRIVATE NAPI_VERSION=10 NAPI_DISABLE_CPP_EXCEPTIONS NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS)
target_link_libraries(better_sqlite3 PRIVATE sqlite node log)

add_library(splayer SHARED bridge.cpp)
target_include_directories(splayer PRIVATE "${SPLAYER_NODE}/include/node")
target_link_libraries(splayer PRIVATE node log)
