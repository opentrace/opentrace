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
