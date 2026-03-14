#include <httplib.h>
#include <iostream>
#include "db.h"

int main() {
    Database db("app.db");
    db.initialize();

    httplib::Server server;

    server.Get("/users", [&db](const httplib::Request &, httplib::Response &res) {
        auto users = db.get_all_users();
        std::string json = "[";
        for (size_t i = 0; i < users.size(); i++) {
            if (i > 0) json += ",";
            json += users[i].to_json();
        }
        json += "]";
        res.set_content(json, "application/json");
    });

    server.Post("/users", [&db](const httplib::Request &req, httplib::Response &res) {
        // Minimal JSON parsing for fixture purposes
        auto name_pos = req.body.find("\"name\"");
        auto email_pos = req.body.find("\"email\"");
        auto extract = [&](size_t pos) -> std::string {
            auto start = req.body.find('"', req.body.find(':', pos)) + 1;
            auto end = req.body.find('"', start);
            return req.body.substr(start, end - start);
        };
        auto user = db.insert_user(extract(name_pos), extract(email_pos));
        res.status = 201;
        res.set_content(user.to_json(), "application/json");
    });

    std::cout << "Server running on port 8080" << std::endl;
    server.listen("127.0.0.1", 8080);
    return 0;
}
