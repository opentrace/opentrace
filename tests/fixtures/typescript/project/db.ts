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

import Database from "better-sqlite3";

interface User {
  id: number;
  name: string;
  email: string;
}

export class UserDatabase {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE
      )
    `);
  }

  getAllUsers(): User[] {
    const stmt = this.db.prepare("SELECT id, name, email FROM users");
    return stmt.all() as User[];
  }

  insertUser(name: string, email: string): User {
    const stmt = this.db.prepare(
      "INSERT INTO users (name, email) VALUES (?, ?)"
    );
    const result = stmt.run(name, email);
    return { id: result.lastInsertRowid as number, name, email };
  }
}

export { UserDatabase as Database };
