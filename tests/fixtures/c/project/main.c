#include <microhttpd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "db.h"

static Database g_db;

static char *users_to_json(User *users, int count) {
    size_t bufsize = 1024 + count * 512;
    char *buf = malloc(bufsize);
    int offset = 0;
    offset += snprintf(buf + offset, bufsize - offset, "[");
    for (int i = 0; i < count; i++) {
        if (i > 0) offset += snprintf(buf + offset, bufsize - offset, ",");
        offset += snprintf(buf + offset, bufsize - offset,
            "{\"id\":%d,\"name\":\"%s\",\"email\":\"%s\"}",
            users[i].id, users[i].name, users[i].email);
    }
    snprintf(buf + offset, bufsize - offset, "]");
    return buf;
}

static enum MHD_Result handle_list_users(struct MHD_Connection *conn) {
    User *users;
    int count;
    db_get_all_users(&g_db, &users, &count);

    char *json = users_to_json(users, count);
    struct MHD_Response *resp = MHD_create_response_from_buffer(
        strlen(json), json, MHD_RESPMEM_MUST_FREE);
    MHD_add_response_header(resp, "Content-Type", "application/json");
    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_OK, resp);
    MHD_destroy_response(resp);
    db_free_users(users);
    return ret;
}

static enum MHD_Result handle_request(void *cls,
    struct MHD_Connection *conn,
    const char *url, const char *method,
    const char *version, const char *upload_data,
    size_t *upload_data_size, void **con_cls)
{
    if (strcmp(url, "/users") == 0 && strcmp(method, "GET") == 0) {
        return handle_list_users(conn);
    }
    struct MHD_Response *resp = MHD_create_response_from_buffer(
        0, NULL, MHD_RESPMEM_PERSISTENT);
    enum MHD_Result ret = MHD_queue_response(conn, MHD_HTTP_NOT_FOUND, resp);
    MHD_destroy_response(resp);
    return ret;
}

int main(void) {
    if (db_open(&g_db, "app.db") != SQLITE_OK) {
        fprintf(stderr, "Failed to open database\n");
        return 1;
    }
    db_initialize(&g_db);

    struct MHD_Daemon *daemon = MHD_start_daemon(
        MHD_USE_SELECT_INTERNALLY, 8080, NULL, NULL,
        &handle_request, NULL, MHD_OPTION_END);

    if (!daemon) {
        fprintf(stderr, "Failed to start server\n");
        db_close(&g_db);
        return 1;
    }

    printf("Server running on port 8080\n");
    getchar();

    MHD_stop_daemon(daemon);
    db_close(&g_db);
    return 0;
}
