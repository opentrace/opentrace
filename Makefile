.PHONY: all install build test clean api agent ui ui-preview proto plugin-reload ui-build-static deploy-preview deploy-live functions-build functions-test functions-emulator fmt lint

all: build

## Generate protobuf code for TS and Python
proto:
	$(MAKE) -C proto all

## Install dependencies for all components
install:
	$(MAKE) -C api build
	$(MAKE) -C agent install
	$(MAKE) -C ui install

## Build all components
build:
	$(MAKE) -C api build
	$(MAKE) -C ui build

## Run all tests
test:
	$(MAKE) -C api test
	$(MAKE) -C agent test

## Clean all build artifacts
clean:
	$(MAKE) -C api clean
	$(MAKE) -C agent clean
	$(MAKE) -C ui clean

## Format all code
fmt:
	$(MAKE) -C api fmt
	$(MAKE) -C agent fmt
	$(MAKE) -C ui fmt

## Lint all code
lint:
	$(MAKE) -C api lint
	$(MAKE) -C agent lint
	$(MAKE) -C ui lint

## Component shortcuts
api:
	$(MAKE) -C api run

agent:
	$(MAKE) -C agent run

ui:
	$(MAKE) -C ui dev

## Firebase deploy
CHANNEL ?= preview

ui-build-static:
	VITE_API_BASE="" VITE_BROWSER_ONLY=true $(MAKE) -C ui build

## Reload the Claude Code plugin (remove and re-add marketplace + plugin)
plugin-reload:
	-claude plugin uninstall opentrace-oss@opentrace-oss
	-claude plugin marketplace remove opentrace-oss
	claude plugin marketplace add ./
	claude plugin install opentrace-oss@opentrace-oss
