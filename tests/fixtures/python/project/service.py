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

"""User service — exercises variable extraction and derivation tracking.

Variable kinds:
  - parameter:  typed, untyped, default-value
  - field:      annotated class attr, bare annotation, self.x in __init__
  - local:      from identifier, call, method call, attribute, compound, literal

Derivation sources:
  - identifier:  y = x
  - call:        y = foo(), y = obj.method()
  - attribute:   y = obj.attr
  - compound:    y = a + b, y = [a, b]
  - literal:     y = 0 (no derivation)
  - unresolved:  y = unknown_func() (no edge produced)
"""

from db import Database


class UserService:
    """Service layer wrapping the database."""

    # Annotated class-level fields
    max_retries: int = 3
    service_name: str

    def __init__(self, db: Database, debug: bool = False):
        # field from parameter (identifier derivation)
        self.db = db
        # field from attribute access
        self.conn = db.conn
        # field from bare call
        self.logger = make_logger()
        # field in nested if block
        if debug:
            self.debug_handler = setup_debug()

    def get_user(self, user_id: int) -> dict:
        # local from method call
        rows = self.db.get_all_users()
        # local from identifier
        data = rows
        # local from attribute access
        count = rows.__len__
        # annotated local
        result: dict = {}
        # local in if/else
        if data:
            user = find_by_id(data, user_id)
        else:
            user = {}
        return user

    def create_user_batch(self, names: list, emails: list):
        # local from compound expression
        total = len(names) + len(emails)
        # local from literal (no derivation)
        created = 0
        # local in for loop
        for i in range(total):
            result = self.db.insert_user(names[i], emails[i])
            created = created + 1
        # local in try/except
        try:
            summary = build_summary(created)
        except Exception:
            summary = "error"
        return summary


    def status(self):
        # local from self.field (attribute with self receiver)
        retries = self.max_retries
        # local from compound: identifier + literal
        remaining = retries - 1
        # local from chained call
        name = str(self.service_name)
        return remaining


def validate_email(address: str, strict: bool = True) -> bool:
    """Top-level function with typed and default parameters."""
    # local from bare call (unresolved — not defined in this file)
    pattern = compile_pattern()
    # local from list with identifiers
    parts = [address, pattern]
    # local from literal
    valid = False
    return valid


def process_batch(items, limit: int = 100):
    """Top-level function with untyped and typed parameters."""
    # local from parameter (identifier)
    data = items
    # local from chained call
    result = transform(parse(data))
    return result


def advanced_patterns(*args, **kwargs):
    """Exercises additional variable patterns."""
    # tuple unpacking
    first, second = args
    # for loop variable
    for key in kwargs:
        pass
    # with-as variable
    with open("log.txt") as logfile:
        pass
    return first
