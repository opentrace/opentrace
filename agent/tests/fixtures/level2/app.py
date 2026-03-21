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

"""Application entry point for benchmark level 2."""

from service import UserService


def main():
    svc = UserService()
    svc.create_user("Alice", "alice@example.com")
    svc.create_user("Bob", "bob@example.com")
    for user in svc.list_users():
        print(user)


if __name__ == "__main__":
    main()
