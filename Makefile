.PHONY: all install build test clean api agent ui ui-preview proto plugin-reload ui-build-static deploy-preview deploy-live functions-build functions-test functions-emulator fmt lint

all: build

## Generate protobuf code (targets: ts, py, go — skips targets whose output dirs are missing)
proto:
	$(MAKE) -C proto ts
	@if [ -d agent ]; then $(MAKE) -C proto py; fi
	@if [ -d api ]; then $(MAKE) -C proto go; fi

## Install dependencies for all components
install:
	@if [ -d api ]; then $(MAKE) -C api build; fi
	@if [ -d agent ]; then $(MAKE) -C agent install; fi
	$(MAKE) -C ui install

## Build all components
build:
	@if [ -d api ]; then $(MAKE) -C api build; fi
	$(MAKE) -C ui build

## Run all tests
test:
	@if [ -d api ]; then $(MAKE) -C api test; fi
	@if [ -d agent ]; then $(MAKE) -C agent test; fi

## Clean all build artifacts
clean:
	@if [ -d api ]; then $(MAKE) -C api clean; fi
	@if [ -d agent ]; then $(MAKE) -C agent clean; fi
	$(MAKE) -C ui clean

## Format all code
fmt:
	@if [ -d api ]; then $(MAKE) -C api fmt; fi
	@if [ -d agent ]; then $(MAKE) -C agent fmt; fi
	$(MAKE) -C ui fmt

## Lint all code
lint:
	@if [ -d api ]; then $(MAKE) -C api lint; fi
	@if [ -d agent ]; then $(MAKE) -C agent lint; fi
	$(MAKE) -C ui lint

## Component shortcuts
api:
	@if [ ! -d api ]; then echo "api/ directory not found — not yet available in the open-source repo." >&2; exit 1; fi
	$(MAKE) -C api run

agent:
	@if [ ! -d agent ]; then echo "agent/ directory not found — not yet available in the open-source repo." >&2; exit 1; fi
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
