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

.PHONY: all install build test clean agent ui components ui-preview proto plugin-reload ui-build-static deploy-preview deploy-live functions-build functions-test functions-emulator fmt lint license-check license-fix

all: build

## Generate protobuf code
proto:
	$(MAKE) -C proto ts
	$(MAKE) -C proto py

## Install dependencies for all components
install:
	$(MAKE) -C components install
	$(MAKE) -C agent install
	$(MAKE) -C ui install

## Build all components
build:
	$(MAKE) -C components build
	$(MAKE) -C ui build

## Run all tests
test:
	$(MAKE) -C agent test

## Clean all build artifacts
clean:
	$(MAKE) -C components clean
	$(MAKE) -C agent clean
	$(MAKE) -C ui clean

## Format all code
fmt:
	$(MAKE) -C agent fmt
	$(MAKE) -C ui fmt

## Lint all code
lint:
	$(MAKE) -C agent lint
	$(MAKE) -C ui lint

## Component shortcuts
components:
	$(MAKE) -C components build

agent:
	$(MAKE) -C agent run

ui:
	$(MAKE) -C ui dev

## Firebase deploy
CHANNEL ?= preview

ui-build-static:
	VITE_API_BASE="" VITE_BROWSER_ONLY=true $(MAKE) -C ui build

## Check that all source files have the Apache 2.0 license header
license-check:
	docker run --rm -v $(CURDIR):/github/workspace apache/skywalking-eyes header check

## Add the Apache 2.0 license header to source files missing it
license-fix:
	docker run --rm -v $(CURDIR):/github/workspace apache/skywalking-eyes header fix

## Reload the Claude Code plugin (remove and re-add marketplace + plugin)
plugin-reload:
	-claude plugin uninstall opentrace-oss@opentrace-oss
	-claude plugin marketplace remove opentrace-oss
	claude plugin marketplace add ./
	claude plugin install opentrace-oss@opentrace-oss
