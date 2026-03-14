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
