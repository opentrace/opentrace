"""Client module for benchmark level 3."""

from models import UserModel


def create_and_validate(id, name):
    user = UserModel(id, name)
    if not user.validate():
        raise ValueError("Invalid user")
    return user


def batch_create(entries):
    results = []
    for entry in entries:
        user = create_and_validate(entry["id"], entry["name"])
        results.append(user)
    return results
