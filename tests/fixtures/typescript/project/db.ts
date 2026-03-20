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

// -- constants --
const TABLE_NAME = "users" as const;
const DEFAULT_ROLE = "user";
const MAX_PAGE_SIZE = 100;

// -- enums --
export enum Role {
  User = "user",
  Admin = "admin",
}

// -- interfaces --
export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  created_at: string;
}

export interface UserFilter {
  role?: Role;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

interface CreateUserInput {
  name: string;
  email: string;
  role?: Role;
}

// -- type aliases --
type UserId = number;
type UserRow = Omit<User, "active"> & { active: number };

// -- custom errors --
export class UserNotFoundError extends Error {
  readonly userId: UserId;
  constructor(id: UserId) {
    super(`User ${id} not found`);
    this.name = "UserNotFoundError";
    this.userId = id;
  }
}

// -- abstract interface --
export interface Repository {
  getAllUsers(filter?: UserFilter): User[];
  getUserById(id: UserId): User;
  insertUser(input: CreateUserInput): User;
  updateUser(id: UserId, updates: Partial<User>): User;
  deleteUser(id: UserId): boolean;
  countUsers(): number;
}

// -- main class --
export class UserDatabase implements Repository {
  private db: Database.Database;
  private readonly readOnly: boolean;
  private static instanceCount = 0;

  constructor(path: string, options?: { readOnly?: boolean }) {
    this.readOnly = options?.readOnly ?? false;
    this.db = new Database(path, { readonly: this.readOnly });
    UserDatabase.instanceCount++;
  }

  initialize(): void {
    if (this.readOnly) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT '${DEFAULT_ROLE}',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  getAllUsers(filter: UserFilter = {}): User[] {
    let query = `SELECT id, name, email, role, active, created_at FROM ${TABLE_NAME} WHERE 1=1`;
    const params: unknown[] = [];

    if (filter.role) {
      query += " AND role = ?";
      params.push(filter.role);
    }
    if (filter.activeOnly) {
      query += " AND active = 1";
    }

    const limit: number = Math.min(filter.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset: number = filter.offset ?? 0;
    query += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as UserRow[];
    return rows.map(toUser);
  }

  getUserById(id: UserId): User {
    const stmt = this.db.prepare(
      `SELECT id, name, email, role, active, created_at FROM ${TABLE_NAME} WHERE id = ?`
    );
    const row = stmt.get(id) as UserRow | undefined;
    if (!row) {
      throw new UserNotFoundError(id);
    }
    return toUser(row);
  }

  insertUser(input: CreateUserInput): User {
    const { name, email } = input;
    const role: Role = input.role ?? Role.User;

    const stmt = this.db.prepare(
      `INSERT INTO ${TABLE_NAME} (name, email, role) VALUES (?, ?, ?)`
    );
    const result = stmt.run(name, email, role);
    const newId = result.lastInsertRowid as number;
    return this.getUserById(newId);
  }

  updateUser(id: UserId, updates: Partial<User>): User {
    this.getUserById(id); // throws if not found

    const allowed: ReadonlySet<string> = new Set(["name", "email", "role", "active"]);
    const entries = Object.entries(updates).filter(([k]) => allowed.has(k));

    for (const [key, value] of entries) {
      const stmt = this.db.prepare(`UPDATE ${TABLE_NAME} SET ${key} = ? WHERE id = ?`);
      stmt.run(value, id);
    }
    return this.getUserById(id);
  }

  deleteUser(id: UserId): boolean {
    const stmt = this.db.prepare(`DELETE FROM ${TABLE_NAME} WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  countUsers(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${TABLE_NAME}`);
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}

// -- module-level helper function --
function toUser(row: UserRow): User {
  return { ...row, active: row.active === 1 };
}

// -- re-export with alias --
export { UserDatabase as Database };
