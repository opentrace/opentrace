// Copyright 2026 OpenTrace Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

mod db;

use actix_web::{get, post, delete, web, App, HttpResponse, HttpServer};
use db::{Database, DbError, Repository, UserFilter};
use serde::Deserialize;
use std::sync::Mutex;

// -- constants --
const DEFAULT_PORT: u16 = 8080;
const DEFAULT_DB_PATH: &str = "app.db";
static VERSION: &str = env!("CARGO_PKG_VERSION");

// -- app state --
struct AppState {
    db: Mutex<Database>,
    request_count: Mutex<u64>,
}

// -- request types --
#[derive(Deserialize)]
struct CreateUserRequest {
    name: String,
    email: String,
    role: Option<String>,
}

#[derive(Deserialize)]
struct ListUsersQuery {
    role: Option<String>,
    active: Option<bool>,
    limit: Option<usize>,
    offset: Option<usize>,
}

// -- route handlers --
#[get("/users")]
async fn list_users(
    data: web::Data<AppState>,
    query: web::Query<ListUsersQuery>,
) -> HttpResponse {
    increment_count(&data);
    let filter = UserFilter {
        role: query.role.clone(),
        active_only: query.active.unwrap_or(false),
        limit: query.limit,
        offset: query.offset,
    };
    let db = data.db.lock().unwrap();
    match db.get_all_users(&filter) {
        Ok(users) => HttpResponse::Ok().json(users),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

#[get("/users/{id}")]
async fn get_user(data: web::Data<AppState>, path: web::Path<i64>) -> HttpResponse {
    increment_count(&data);
    let id: i64 = path.into_inner();
    let db = data.db.lock().unwrap();
    match db.get_user_by_id(id) {
        Ok(user) => HttpResponse::Ok().json(user),
        Err(DbError::NotFound(_)) => HttpResponse::NotFound().body("user not found"),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

#[post("/users")]
async fn create_user(
    data: web::Data<AppState>,
    body: web::Json<CreateUserRequest>,
) -> HttpResponse {
    increment_count(&data);
    let role: &str = body.role.as_deref().unwrap_or("user");
    let db = data.db.lock().unwrap();
    match db.insert_user(&body.name, &body.email, role) {
        Ok(user) => HttpResponse::Created().json(user),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

#[delete("/users/{id}")]
async fn delete_user(data: web::Data<AppState>, path: web::Path<i64>) -> HttpResponse {
    let id = path.into_inner();
    let db = data.db.lock().unwrap();
    match db.delete_user(id) {
        Ok(true) => HttpResponse::NoContent().finish(),
        Ok(false) => HttpResponse::NotFound().body("user not found"),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

#[get("/health")]
async fn health(data: web::Data<AppState>) -> HttpResponse {
    let count = *data.request_count.lock().unwrap();
    HttpResponse::Ok().json(serde_json::json!({
        "status": "ok",
        "version": VERSION,
        "requests": count,
    }))
}

// -- helpers --
fn increment_count(data: &web::Data<AppState>) {
    let mut count = data.request_count.lock().unwrap();
    *count += 1;
}

// -- main --
#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    let db_path: String = std::env::var("DB_PATH").unwrap_or_else(|_| DEFAULT_DB_PATH.to_string());

    let database = Database::new(&db_path).expect("Failed to open database");
    database.initialize().expect("Failed to initialize schema");

    let data = web::Data::new(AppState {
        db: Mutex::new(database),
        request_count: Mutex::new(0),
    });

    println!("Server {} listening on port {}", VERSION, port);

    HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .service(list_users)
            .service(get_user)
            .service(create_user)
            .service(delete_user)
            .service(health)
    })
    .bind(("127.0.0.1", port))?
    .run()
    .await
}
