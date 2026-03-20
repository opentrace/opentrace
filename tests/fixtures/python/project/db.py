# Copyright 2026 OpenTrace Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import annotations

import sqlite3
from abc import ABC, abstractmethod
from contextlib import contextmanager
from typing import Any, ClassVar, Final, Generator, Optional


# -- module constants --
TABLE_NAME: Final[str] = "users"
DEFAULT_ROLE: Final[str] = "user"
_SCHEMA_VERSION: int = 2


# -- custom exceptions --
class UserNotFoundError(Exception):
    pass


class DatabaseError(Exception):
    pass


# -- abstract base --
class BaseRepository(ABC):
    @abstractmethod
    def get_all(self) -> list[dict[str, Any]]:
        ...

    @abstractmethod
    def get_by_id(self, id: int) -> Optional[dict[str, Any]]:
        ...

    @abstractmethod
    def insert(self, **kwargs: Any) -> dict[str, Any]:
        ...

    @abstractmethod
    def delete(self, id: int) -> bool:
        ...


# -- main database class --
class Database:
    MAX_RETRIES: ClassVar[int] = 3
    _instance_count: ClassVar[int] = 0

    def __init__(self, path: str, *, read_only: bool = False):
        self.path: str = path
        self._read_only: bool = read_only
        self.conn: Optional[sqlite3.Connection] = None
        self._schema_version: int = _SCHEMA_VERSION
        Database._instance_count += 1

    def initialize(self) -> None:
        mode: str = "ro" if self._read_only else "rwc"
        uri: str = f"file:{self.path}?mode={mode}"
        self.conn = sqlite3.connect(uri, uri=True)
        self.conn.row_factory = sqlite3.Row
        if not self._read_only:
            self._migrate()

    def _migrate(self) -> None:
        assert self.conn is not None
        self.conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL DEFAULT '{DEFAULT_ROLE}',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self.conn.commit()

    @contextmanager
    def _transaction(self) -> Generator[sqlite3.Connection, None, None]:
        assert self.conn is not None
        try:
            yield self.conn
            self.conn.commit()
        except sqlite3.Error:
            self.conn.rollback()
            raise

    def ping(self) -> bool:
        try:
            if self.conn is None:
                return False
            self.conn.execute("SELECT 1")
            return True
        except sqlite3.Error:
            return False

    # -- CRUD operations --
    def get_all_users(self, *, active_only: bool = False) -> list[dict[str, Any]]:
        assert self.conn is not None
        query: str = f"SELECT id, name, email, role, active FROM {TABLE_NAME}"
        params: tuple = ()
        if active_only:
            query += " WHERE active = ?"
            params = (1,)
        cursor: sqlite3.Cursor = self.conn.execute(query, params)
        rows = cursor.fetchall()
        return [dict(r) for r in rows]

    def get_user_by_id(self, user_id: int) -> dict[str, Any]:
        assert self.conn is not None
        cursor = self.conn.execute(
            f"SELECT id, name, email, role, active FROM {TABLE_NAME} WHERE id = ?",
            (user_id,),
        )
        row: Optional[sqlite3.Row] = cursor.fetchone()
        if row is None:
            raise UserNotFoundError(f"User {user_id} not found")
        return dict(row)

    def insert_user(self, name: str, email: str, *, role: str = DEFAULT_ROLE) -> dict[str, Any]:
        with self._transaction() as conn:
            cursor = conn.execute(
                f"INSERT INTO {TABLE_NAME} (name, email, role) VALUES (?, ?, ?)",
                (name, email, role),
            )
            new_id: int = cursor.lastrowid
        return {"id": new_id, "name": name, "email": email, "role": role}

    def update_user(self, user_id: int, **fields: Any) -> dict[str, Any]:
        allowed: frozenset[str] = frozenset({"name", "email", "role", "active"})
        updates: dict[str, Any] = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return self.get_user_by_id(user_id)

        set_clause: str = ", ".join(f"{k} = ?" for k in updates)
        values: list[Any] = list(updates.values()) + [user_id]

        with self._transaction() as conn:
            conn.execute(
                f"UPDATE {TABLE_NAME} SET {set_clause} WHERE id = ?",
                values,
            )
        return self.get_user_by_id(user_id)

    def delete_user(self, user_id: int) -> bool:
        with self._transaction() as conn:
            cursor = conn.execute(
                f"DELETE FROM {TABLE_NAME} WHERE id = ?",
                (user_id,),
            )
            deleted: bool = cursor.rowcount > 0
        return deleted

    def count_users(self, *, role: Optional[str] = None) -> int:
        assert self.conn is not None
        if role is not None:
            cursor = self.conn.execute(
                f"SELECT COUNT(*) FROM {TABLE_NAME} WHERE role = ?", (role,)
            )
        else:
            cursor = self.conn.execute(f"SELECT COUNT(*) FROM {TABLE_NAME}")
        (total,) = cursor.fetchone()
        return total

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None
