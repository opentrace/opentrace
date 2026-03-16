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

#pragma once

#include <sqlite3.h>
#include <string>
#include <vector>

struct User {
    int64_t id;
    std::string name;
    std::string email;

    std::string to_json() const;
};

class Database {
public:
    explicit Database(const std::string &path);
    ~Database();

    Database(const Database &) = delete;
    Database &operator=(const Database &) = delete;

    void initialize();
    std::vector<User> get_all_users();
    User insert_user(const std::string &name, const std::string &email);

private:
    sqlite3 *conn_ = nullptr;
};
