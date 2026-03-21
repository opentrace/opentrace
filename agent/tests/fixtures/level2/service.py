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
