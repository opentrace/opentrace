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

use actix_web::{get, post, web, App, HttpResponse, HttpServer};
use db::Database;
use serde::Deserialize;
use std::sync::Mutex;

struct AppState {
    db: Mutex<Database>,
}

#[derive(Deserialize)]
struct CreateUserRequest {
    name: String,
    email: String,
}

#[get("/users")]
async fn list_users(data: web::Data<AppState>) -> HttpResponse {
    let db = data.db.lock().unwrap();
    match db.get_all_users() {
        Ok(users) => HttpResponse::Ok().json(users),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

#[post("/users")]
async fn create_user(
    data: web::Data<AppState>,
    body: web::Json<CreateUserRequest>,
) -> HttpResponse {
    let db = data.db.lock().unwrap();
    match db.insert_user(&body.name, &body.email) {
        Ok(user) => HttpResponse::Created().json(user),
        Err(e) => HttpResponse::InternalServerError().body(e.to_string()),
    }
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let database = Database::new("app.db").expect("Failed to open database");
    database.initialize().expect("Failed to initialize schema");

    let data = web::Data::new(AppState {
        db: Mutex::new(database),
    });

    HttpServer::new(move || {
        App::new()
            .app_data(data.clone())
            .service(list_users)
            .service(create_user)
    })
    .bind("127.0.0.1:8080")?
    .run()
    .await
}
