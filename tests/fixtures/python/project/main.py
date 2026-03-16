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

from flask import Flask, jsonify, request
from db import Database

app = Flask(__name__)
db = Database("app.db")


@app.route("/users", methods=["GET"])
def list_users():
    users = db.get_all_users()
    return jsonify(users)


@app.route("/users", methods=["POST"])
def create_user():
    data = request.get_json()
    user = db.insert_user(data["name"], data["email"])
    return jsonify(user), 201


if __name__ == "__main__":
    db.initialize()
    app.run(port=8080)
