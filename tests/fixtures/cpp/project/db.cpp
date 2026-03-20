/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "db.h"
#include <stdexcept>
#include <sstream>

// -- constants --
static const char* TABLE_NAME = "users";
static const char* DEFAULT_ROLE = "user";
static constexpr int MAX_PAGE_SIZE = 100;
static constexpr int SCHEMA_VERSION = 2;

// -- User methods --
std::string User::to_json() const {
    std::ostringstream ss;
    ss << "{\"id\":" << id
       << ",\"name\":\"" << name
       << "\",\"email\":\"" << email
       << "\",\"role\":\"" << role
       << "\",\"active\":" << (active ? "true" : "false") << "}";
    return ss.str();
}

bool User::is_admin() const {
    return role == "admin";
}

// -- Database construction/destruction --
Database::Database(const std::string &path) : conn_(nullptr), read_only_(false) {
    if (sqlite3_open(path.c_str(), &conn_) != SQLITE_OK) {
        throw std::runtime_error("Failed to open database");
    }
}

Database::Database(const std::string &path, bool read_only) : conn_(nullptr), read_only_(read_only) {
    int flags = read_only ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
    if (sqlite3_open_v2(path.c_str(), &conn_, flags, nullptr) != SQLITE_OK) {
        throw std::runtime_error("Failed to open database");
    }
}

Database::~Database() {
    if (conn_) sqlite3_close(conn_);
}

// -- schema --
void Database::initialize() {
    if (read_only_) return;

    std::string sql =
        "CREATE TABLE IF NOT EXISTS " + std::string(TABLE_NAME) + " ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  name TEXT NOT NULL,"
        "  email TEXT NOT NULL UNIQUE,"
        "  role TEXT NOT NULL DEFAULT '" + std::string(DEFAULT_ROLE) + "',"
        "  active INTEGER NOT NULL DEFAULT 1"
        ")";

    char *err = nullptr;
    if (sqlite3_exec(conn_, sql.c_str(), nullptr, nullptr, &err) != SQLITE_OK) {
        std::string msg = err;
        sqlite3_free(err);
        throw std::runtime_error(msg);
    }
}

// -- CRUD operations --
std::vector<User> Database::get_all_users() {
    return get_all_users("", MAX_PAGE_SIZE, 0);
}

std::vector<User> Database::get_all_users(const std::string &role, int limit, int offset) {
    int effective_limit = std::min(limit, MAX_PAGE_SIZE);
    std::string sql = "SELECT id, name, email, role, active FROM " + std::string(TABLE_NAME) + " WHERE 1=1";

    if (!role.empty()) {
        sql += " AND role = '" + role + "'";
    }
    sql += " LIMIT " + std::to_string(effective_limit) + " OFFSET " + std::to_string(offset);

    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn_, sql.c_str(), -1, &stmt, nullptr);

    std::vector<User> users;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        User u;
        u.id = sqlite3_column_int64(stmt, 0);
        u.name = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 1));
        u.email = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 2));
        u.role = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 3));
        u.active = sqlite3_column_int(stmt, 4) == 1;
        users.push_back(u);
    }
    sqlite3_finalize(stmt);
    return users;
}

User Database::get_user_by_id(int64_t id) {
    std::string sql = "SELECT id, name, email, role, active FROM " + std::string(TABLE_NAME) + " WHERE id = ?";
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn_, sql.c_str(), -1, &stmt, nullptr);
    sqlite3_bind_int64(stmt, 1, id);

    if (sqlite3_step(stmt) != SQLITE_ROW) {
        sqlite3_finalize(stmt);
        throw std::runtime_error("User not found");
    }

    User u;
    u.id = sqlite3_column_int64(stmt, 0);
    u.name = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 1));
    u.email = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 2));
    u.role = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 3));
    u.active = sqlite3_column_int(stmt, 4) == 1;
    sqlite3_finalize(stmt);
    return u;
}

User Database::insert_user(const std::string &name, const std::string &email) {
    return insert_user(name, email, DEFAULT_ROLE);
}

User Database::insert_user(const std::string &name, const std::string &email, const std::string &role) {
    std::string sql = "INSERT INTO " + std::string(TABLE_NAME) + " (name, email, role) VALUES (?, ?, ?)";
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn_, sql.c_str(), -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, name.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, email.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 3, role.c_str(), -1, SQLITE_STATIC);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        sqlite3_finalize(stmt);
        throw std::runtime_error("Failed to insert user");
    }
    sqlite3_finalize(stmt);

    int64_t id = sqlite3_last_insert_rowid(conn_);
    return User{id, name, email, role, true};
}

bool Database::delete_user(int64_t id) {
    std::string sql = "DELETE FROM " + std::string(TABLE_NAME) + " WHERE id = ?";
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn_, sql.c_str(), -1, &stmt, nullptr);
    sqlite3_bind_int64(stmt, 1, id);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return sqlite3_changes(conn_) > 0;
}

int Database::count_users() {
    std::string sql = "SELECT COUNT(*) FROM " + std::string(TABLE_NAME);
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn_, sql.c_str(), -1, &stmt, nullptr);
    sqlite3_step(stmt);
    int count = sqlite3_column_int(stmt, 0);
    sqlite3_finalize(stmt);
    return count;
}
