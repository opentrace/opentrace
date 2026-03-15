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
