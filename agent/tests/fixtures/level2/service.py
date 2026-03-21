"""User service for benchmark level 2."""

from models import User
from validator import validate_email, validate_name


class UserService:
    """Manages user creation with validation."""

    def __init__(self):
        self.users = []

    def create_user(self, name, email):
        if not validate_name(name):
            raise ValueError("Invalid name")
        if not validate_email(email):
            raise ValueError("Invalid email")
        user = User(name, email)
        self.users.append(user)
        return user

    def list_users(self):
        return [u.to_dict() for u in self.users]
