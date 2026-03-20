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

from dataclasses import dataclass, field
from enum import Enum
from typing import Final, Optional

from flask import Flask, jsonify, request
from db import Database, UserNotFoundError

# -- module-level constants and variables --
APP_NAME: Final[str] = "user-service"
DEFAULT_PORT: Final[int] = 8080
MAX_PAGE_SIZE = 100
_request_count: int = 0

app = Flask(APP_NAME)
db = Database("app.db")


# -- enums --
class SortOrder(Enum):
    ASC = "asc"
    DESC = "desc"


# -- dataclasses --
@dataclass
class PaginationParams:
    page: int = 1
    per_page: int = 20
    sort_by: str = "id"
    sort_order: SortOrder = SortOrder.ASC
    filters: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class AppConfig:
    port: int = DEFAULT_PORT
    debug: bool = False
    db_path: str = "app.db"
    max_connections: int = 5


# -- typed function parameters, various signatures --
def parse_pagination(
    page: int | None = None,
    per_page: int | None = None,
    sort_by: str = "id",
    order: str = "asc",
) -> PaginationParams:
    effective_page: int = max(1, page or 1)
    effective_per_page: int = min(per_page or 20, MAX_PAGE_SIZE)
    sort_order = SortOrder(order)
    return PaginationParams(
        page=effective_page,
        per_page=effective_per_page,
        sort_by=sort_by,
        sort_order=sort_order,
    )


def _increment_request_count() -> int:
    global _request_count
    _request_count += 1
    return _request_count


# -- routes with various variable patterns --
@app.route("/users", methods=["GET"])
def list_users():
    _increment_request_count()
    page = request.args.get("page", type=int)
    per_page = request.args.get("per_page", type=int)
    pagination = parse_pagination(page, per_page)

    users = db.get_all_users()

    # tuple unpacking
    start, end = (pagination.page - 1) * pagination.per_page, pagination.page * pagination.per_page
    paginated = users[start:end]

    return jsonify({"users": paginated, "total": len(users), "page": pagination.page})


@app.route("/users/<int:user_id>", methods=["GET"])
def get_user(user_id: int):
    _increment_request_count()
    try:
        user: Optional[dict] = db.get_user_by_id(user_id)
    except UserNotFoundError as exc:
        message: str = str(exc)
        return jsonify({"error": message}), 404
    return jsonify(user)


@app.route("/users", methods=["POST"])
def create_user():
    _increment_request_count()
    data = request.get_json()
    name: str = data["name"]
    email: str = data["email"]
    role: str = data.get("role", "user")
    user = db.insert_user(name, email, role=role)
    return jsonify(user), 201


@app.route("/users/<int:user_id>", methods=["PUT"])
def update_user(user_id: int):
    data: dict = request.get_json()
    updated = db.update_user(user_id, **data)
    return jsonify(updated)


@app.route("/users/<int:user_id>", methods=["DELETE"])
def delete_user(user_id: int):
    db.delete_user(user_id)
    return "", 204


# -- async helper (Python 3.11+) --
async def healthcheck() -> dict[str, str | bool]:
    status: str = "healthy"
    db_ok: bool = db.ping()
    return {"status": status, "database": db_ok}


# -- with-statement, for-loop, walrus operator --
def export_users(path: str) -> int:
    users = db.get_all_users()
    count: int = 0
    with open(path, "w") as f:
        for user in users:
            line: str = f"{user['name']},{user['email']}\n"
            f.write(line)
            count += 1
    return count


# -- lambda and comprehension --
sort_by_name = lambda users: sorted(users, key=lambda u: u["name"])
active_emails: list[str] = [u["email"] for u in db.get_all_users() if u.get("active")]


if __name__ == "__main__":
    config = AppConfig()
    db.initialize()
    app.run(port=config.port, debug=config.debug)
