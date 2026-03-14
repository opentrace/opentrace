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
