#include "db.h"
#include <stdlib.h>
#include <string.h>

int db_open(Database *db, const char *path) {
    return sqlite3_open(path, &db->conn);
}

int db_initialize(Database *db) {
    const char *sql =
        "CREATE TABLE IF NOT EXISTS users ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  name TEXT NOT NULL,"
        "  email TEXT NOT NULL UNIQUE"
        ")";
    return sqlite3_exec(db->conn, sql, NULL, NULL, NULL);
}

int db_get_all_users(Database *db, User **users, int *count) {
    sqlite3_stmt *stmt;
    int rc = sqlite3_prepare_v2(db->conn, "SELECT id, name, email FROM users", -1, &stmt, NULL);
    if (rc != SQLITE_OK) return rc;

    int capacity = 16;
    *users = malloc(capacity * sizeof(User));
    *count = 0;

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        if (*count >= capacity) {
            capacity *= 2;
            *users = realloc(*users, capacity * sizeof(User));
        }
        User *u = &(*users)[*count];
        u->id = sqlite3_column_int(stmt, 0);
        strncpy(u->name, (const char *)sqlite3_column_text(stmt, 1), sizeof(u->name) - 1);
        strncpy(u->email, (const char *)sqlite3_column_text(stmt, 2), sizeof(u->email) - 1);
        (*count)++;
    }

    sqlite3_finalize(stmt);
    return SQLITE_OK;
}

int db_insert_user(Database *db, const char *name, const char *email, User *out) {
    sqlite3_stmt *stmt;
    int rc = sqlite3_prepare_v2(db->conn,
        "INSERT INTO users (name, email) VALUES (?, ?)", -1, &stmt, NULL);
    if (rc != SQLITE_OK) return rc;

    sqlite3_bind_text(stmt, 1, name, -1, SQLITE_STATIC);
    sqlite3_bind_text(stmt, 2, email, -1, SQLITE_STATIC);

    rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE) return rc;

    out->id = (int)sqlite3_last_insert_rowid(db->conn);
    strncpy(out->name, name, sizeof(out->name) - 1);
    strncpy(out->email, email, sizeof(out->email) - 1);
    return SQLITE_OK;
}

void db_close(Database *db) {
    if (db->conn) {
        sqlite3_close(db->conn);
        db->conn = NULL;
    }
}

void db_free_users(User *users) {
    free(users);
}
