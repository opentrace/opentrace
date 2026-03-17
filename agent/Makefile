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

.PHONY: install run test fmt lint clean

install:
	uv sync

run:
	uv run opentrace-agent-server --config ../api/config.yaml

test:
	uv run pytest tests/

## Format Python source files
fmt:
	uv run ruff format src/ tests/

## Run linters and check formatting
lint:
	uv run ruff check src/ tests/
	uv run ruff format --check src/ tests/

clean:
	rm -rf .venv __pycache__ src/*.egg-info
