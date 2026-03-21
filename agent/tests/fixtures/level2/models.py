"""User model for benchmark level 2."""


class User:
    """Represents a user in the system."""

    def __init__(self, name, email):
        self.name = name
        self.email = email

    def to_dict(self):
        return {"name": self.name, "email": self.email}
