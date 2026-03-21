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
