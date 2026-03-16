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

use rusqlite::{params, Connection, Result};
use serde::Serialize;

#[derive(Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn new(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        Ok(Database { conn })
    }

    pub fn initialize(&self) -> Result<()> {
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE
            )",
            [],
        )?;
        Ok(())
    }

    pub fn get_all_users(&self) -> Result<Vec<User>> {
        let mut stmt = self.conn.prepare("SELECT id, name, email FROM users")?;
        let users = stmt
            .query_map([], |row| {
                Ok(User {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    email: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        Ok(users)
    }

    pub fn insert_user(&self, name: &str, email: &str) -> Result<User> {
        self.conn.execute(
            "INSERT INTO users (name, email) VALUES (?1, ?2)",
            params![name, email],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(User {
            id,
            name: name.to_string(),
            email: email.to_string(),
        })
    }
}
