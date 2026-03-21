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

"""Simple calculator module for benchmark level 1."""


class Calculator:
    """A basic calculator that records operation history."""

    def __init__(self):
        self.history = []

    def add(self, a, b):
        result = a + b
        self._record("add", result)
        return result

    def multiply(self, a, b):
        result = a * b
        self._record("multiply", result)
        return result

    def _record(self, operation, result):
        self.history.append({"op": operation, "result": result})


def main():
    calc = Calculator()
    print(calc.add(2, 3))
    print(calc.multiply(4, 5))


if __name__ == "__main__":
    main()
