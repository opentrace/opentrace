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
use serde::{Deserialize, Serialize};
use std::fmt;

// -- constants --
const TABLE_NAME: &str = "users";
const DEFAULT_ROLE: &str = "user";
const MAX_PAGE_SIZE: usize = 100;

// -- enums --
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Role {
    User,
    Admin,
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Role::User => write!(f, "user"),
            Role::Admin => write!(f, "admin"),
        }
    }
}

impl Default for Role {
    fn default() -> Self {
        Role::User
    }
}

// -- error type --
#[derive(Debug)]
pub enum DbError {
    NotFound(i64),
    Sqlite(rusqlite::Error),
    DuplicateEmail(String),
}

impl From<rusqlite::Error> for DbError {
    fn from(err: rusqlite::Error) -> Self {
        DbError::Sqlite(err)
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::NotFound(id) => write!(f, "user {} not found", id),
            DbError::Sqlite(e) => write!(f, "database error: {}", e),
            DbError::DuplicateEmail(e) => write!(f, "duplicate email: {}", e),
        }
    }
}

// -- structs --
#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub role: String,
    pub active: bool,
}

#[derive(Debug, Deserialize)]
pub struct UserFilter {
    pub role: Option<String>,
    pub active_only: bool,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

impl Default for UserFilter {
    fn default() -> Self {
        UserFilter {
            role: None,
            active_only: false,
            limit: None,
            offset: None,
        }
    }
}

// -- trait --
pub trait Repository {
    fn get_all_users(&self, filter: &UserFilter) -> std::result::Result<Vec<User>, DbError>;
    fn get_user_by_id(&self, id: i64) -> std::result::Result<User, DbError>;
    fn insert_user(&self, name: &str, email: &str, role: &str) -> std::result::Result<User, DbError>;
    fn delete_user(&self, id: i64) -> std::result::Result<bool, DbError>;
    fn count_users(&self) -> std::result::Result<usize, DbError>;
}

// -- database struct --
pub struct Database {
    conn: Connection,
    read_only: bool,
}

impl Database {
    pub fn new(path: &str) -> Result<Self> {
        let conn = Connection::open(path)?;
        Ok(Database { conn, read_only: false })
    }

    pub fn new_read_only(path: &str) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        Ok(Database { conn, read_only: true })
    }

    pub fn initialize(&self) -> Result<()> {
        if self.read_only {
            return Ok(());
        }
        self.conn.execute(
            &format!(
                "CREATE TABLE IF NOT EXISTS {} (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    role TEXT NOT NULL DEFAULT '{}',
                    active INTEGER NOT NULL DEFAULT 1
                )",
                TABLE_NAME, DEFAULT_ROLE
            ),
            [],
        )?;
        Ok(())
    }
}

impl Repository for Database {
    fn get_all_users(&self, filter: &UserFilter) -> std::result::Result<Vec<User>, DbError> {
        let mut query = format!("SELECT id, name, email, role, active FROM {} WHERE 1=1", TABLE_NAME);
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref role) = filter.role {
            query.push_str(" AND role = ?");
            param_values.push(Box::new(role.clone()));
        }
        if filter.active_only {
            query.push_str(" AND active = 1");
        }

        let limit: usize = filter.limit.unwrap_or(MAX_PAGE_SIZE).min(MAX_PAGE_SIZE);
        let offset: usize = filter.offset.unwrap_or(0);
        query.push_str(&format!(" LIMIT {} OFFSET {}", limit, offset));

        let params_refs: Vec<&dyn rusqlite::types::ToSql> = param_values.iter().map(|p| p.as_ref()).collect();
        let mut stmt = self.conn.prepare(&query)?;
        let users = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(User {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    email: row.get(2)?,
                    role: row.get(3)?,
                    active: row.get::<_, i32>(4)? == 1,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
        Ok(users)
    }

    fn get_user_by_id(&self, id: i64) -> std::result::Result<User, DbError> {
        let query = format!("SELECT id, name, email, role, active FROM {} WHERE id = ?", TABLE_NAME);
        self.conn
            .query_row(&query, params![id], |row| {
                Ok(User {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    email: row.get(2)?,
                    role: row.get(3)?,
                    active: row.get::<_, i32>(4)? == 1,
                })
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => DbError::NotFound(id),
                other => DbError::Sqlite(other),
            })
    }

    fn insert_user(&self, name: &str, email: &str, role: &str) -> std::result::Result<User, DbError> {
        self.conn.execute(
            &format!("INSERT INTO {} (name, email, role) VALUES (?1, ?2, ?3)", TABLE_NAME),
            params![name, email, role],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(User {
            id,
            name: name.to_string(),
            email: email.to_string(),
            role: role.to_string(),
            active: true,
        })
    }

    fn delete_user(&self, id: i64) -> std::result::Result<bool, DbError> {
        let affected = self.conn.execute(
            &format!("DELETE FROM {} WHERE id = ?", TABLE_NAME),
            params![id],
        )?;
        Ok(affected > 0)
    }

    fn count_users(&self) -> std::result::Result<usize, DbError> {
        let count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM {}", TABLE_NAME),
            [],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }
}
