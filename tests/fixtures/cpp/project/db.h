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
