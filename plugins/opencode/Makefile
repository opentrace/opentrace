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

.PHONY: install build test fmt lint clean

install:
	bun install

# @opencode-ai/plugin is externalized in package.json's build script —
# it's provided by OpenCode's runtime, not bundled.
build:
	bun run build

test:
	bun test

fmt:
	@echo "no formatter configured for opencode plugin"

lint:
	bun run lint

clean:
	rm -rf node_modules dist
