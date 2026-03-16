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

std::string User::to_json() const {
    return "{\"id\":" + std::to_string(id) +
           ",\"name\":\"" + name +
           "\",\"email\":\"" + email + "\"}";
}

Database::Database(const std::string &path) {
    if (sqlite3_open(path.c_str(), &conn_) != SQLITE_OK) {
        throw std::runtime_error("Failed to open database");
    }
}

Database::~Database() {
    if (conn_) sqlite3_close(conn_);
}

void Database::initialize() {
    const char *sql =
        "CREATE TABLE IF NOT EXISTS users ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  name TEXT NOT NULL,"
        "  email TEXT NOT NULL UNIQUE"
        ")";
    char *err = nullptr;
    if (sqlite3_exec(conn_, sql, nullptr, nullptr, &err) != SQLITE_OK) {
        std::string msg = err;
        sqlite3_free(err);
        throw std::runtime_error(msg);
    }
}

std::vector<User> Database::get_all_users() {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn_, "SELECT id, name, email FROM users", -1, &stmt, nullptr);

    std::vector<User> users;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        User u;
        u.id = sqlite3_column_int64(stmt, 0);
        u.name = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 1));
        u.email = reinterpret_cast<const char *>(sqlite3_column_text(stmt, 2));
        users.push_back(u);
    }
    sqlite3_finalize(stmt);
    return users;
}

User Database::insert_user(const std::string &name, const std::string &email) {
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(conn_,
        "INSERT INTO users (name, email) VALUES (?, ?)", -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, name.c_str(), -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, email.c_str(), -1, SQLITE_STATIC);

    if (sqlite3_step(stmt) != SQLITE_DONE) {
        sqlite3_finalize(stmt);
        throw std::runtime_error("Failed to insert user");
    }
    sqlite3_finalize(stmt);

    int64_t id = sqlite3_last_insert_rowid(conn_);
    return User{id, name, email};
}
