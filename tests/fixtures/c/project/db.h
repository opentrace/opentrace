#ifndef DB_H
#define DB_H

#include <sqlite3.h>

typedef struct {
    int id;
    char name[256];
    char email[256];
} User;

typedef struct {
    sqlite3 *conn;
} Database;

int db_open(Database *db, const char *path);
int db_initialize(Database *db);
int db_get_all_users(Database *db, User **users, int *count);
int db_insert_user(Database *db, const char *name, const char *email, User *out);
void db_close(Database *db);
void db_free_users(User *users);

#endif
