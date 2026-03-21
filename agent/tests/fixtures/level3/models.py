"""Models with inheritance for benchmark level 3."""


class BaseModel:
    """Base class for all models."""

    def __init__(self, id):
        self.id = id

    def validate(self):
        return self.id is not None


class UserModel(BaseModel):
    """User model with validation."""

    def __init__(self, id, name):
        super().__init__(id)
        self.name = name

    def validate(self):
        base_valid = super().validate()
        return base_valid and bool(self.name)
