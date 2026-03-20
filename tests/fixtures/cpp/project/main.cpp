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

#include <httplib.h>
#include <iostream>
#include <sstream>
#include <string>
#include "db.h"

// -- constants --
static const int DEFAULT_PORT = 8080;
static const char* DEFAULT_DB_PATH = "app.db";
static const char* API_VERSION = "v1";
static const char* CONTENT_TYPE_JSON = "application/json";

// -- helpers --
static std::string users_to_json(const std::vector<User> &users) {
    std::ostringstream json;
    json << "[";
    for (size_t i = 0; i < users.size(); i++) {
        if (i > 0) json << ",";
        json << users[i].to_json();
    }
    json << "]";
    return json.str();
}

static std::string extract_json_field(const std::string &body, const std::string &field) {
    auto pos = body.find("\"" + field + "\"");
    if (pos == std::string::npos) return "";
    auto start = body.find('"', body.find(':', pos)) + 1;
    auto end = body.find('"', start);
    return body.substr(start, end - start);
}

static void send_error(httplib::Response &res, int status, const std::string &msg) {
    res.status = status;
    res.set_content("{\"error\":\"" + msg + "\"}", CONTENT_TYPE_JSON);
}

// -- main --
int main(int argc, char *argv[]) {
    int port = DEFAULT_PORT;
    const char* db_path = DEFAULT_DB_PATH;

    if (argc > 1) {
        port = std::stoi(argv[1]);
    }

    Database db(db_path);
    db.initialize();

    httplib::Server server;
    int request_count = 0;

    // -- list users --
    server.Get("/users", [&db, &request_count](const httplib::Request &req, httplib::Response &res) {
        request_count++;
        std::string role = req.get_param_value("role");
        int limit = req.has_param("limit") ? std::stoi(req.get_param_value("limit")) : 100;
        int offset = req.has_param("offset") ? std::stoi(req.get_param_value("offset")) : 0;

        auto users = db.get_all_users(role, limit, offset);
        std::string json = users_to_json(users);
        res.set_content(json, CONTENT_TYPE_JSON);
    });

    // -- get user by id --
    server.Get(R"(/users/(\d+))", [&db, &request_count](const httplib::Request &req, httplib::Response &res) {
        request_count++;
        int64_t id = std::stoll(req.matches[1]);
        try {
            auto user = db.get_user_by_id(id);
            res.set_content(user.to_json(), CONTENT_TYPE_JSON);
        } catch (const std::runtime_error &e) {
            send_error(res, 404, e.what());
        }
    });

    // -- create user --
    server.Post("/users", [&db, &request_count](const httplib::Request &req, httplib::Response &res) {
        request_count++;
        std::string name = extract_json_field(req.body, "name");
        std::string email = extract_json_field(req.body, "email");
        std::string role = extract_json_field(req.body, "role");
        if (role.empty()) role = "user";

        try {
            auto user = db.insert_user(name, email, role);
            res.status = 201;
            res.set_content(user.to_json(), CONTENT_TYPE_JSON);
        } catch (const std::runtime_error &e) {
            send_error(res, 400, e.what());
        }
    });

    // -- delete user --
    server.Delete(R"(/users/(\d+))", [&db](const httplib::Request &req, httplib::Response &res) {
        int64_t id = std::stoll(req.matches[1]);
        bool deleted = db.delete_user(id);
        if (deleted) {
            res.status = 204;
        } else {
            send_error(res, 404, "user not found");
        }
    });

    // -- health check --
    server.Get("/health", [&request_count](const httplib::Request &, httplib::Response &res) {
        std::ostringstream json;
        json << "{\"status\":\"ok\",\"version\":\"" << API_VERSION
             << "\",\"requests\":" << request_count << "}";
        res.set_content(json.str(), CONTENT_TYPE_JSON);
    });

    std::cout << "Server " << API_VERSION << " running on port " << port << std::endl;
    server.listen("127.0.0.1", port);
    return 0;
}
