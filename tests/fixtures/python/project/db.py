import sqlite3


class Database:
    def __init__(self, path: str):
        self.path = path
        self.conn = None

    def initialize(self):
        self.conn = sqlite3.connect(self.path)
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE
            )
            """
        )
        self.conn.commit()

    def get_all_users(self) -> list[dict]:
        cursor = self.conn.execute("SELECT id, name, email FROM users")
        rows = cursor.fetchall()
        return [{"id": r[0], "name": r[1], "email": r[2]} for r in rows]

    def insert_user(self, name: str, email: str) -> dict:
        cursor = self.conn.execute(
            "INSERT INTO users (name, email) VALUES (?, ?)",
            (name, email),
        )
        self.conn.commit()
        return {"id": cursor.lastrowid, "name": name, "email": email}
