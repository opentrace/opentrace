# OpenTrace Benchmark Runner
#
# Usage:
#   make download          — fetch SWE-bench Lite dataset
#   make accuracy          — run graph accuracy benchmarks (all 3 levels)
#   make accuracy-1        — run level 1 only (single file, 8 tasks)
#   make swe-bench-smoke   — run 1 SWE-bench instance (sanity check)
#   make swe-bench-5       — run 5 instances from different repos
#   make swe-bench         — run all 300 instances
#   make compare           — A/B comparison (with vs without OpenTrace)

AGENT_DIR := ../agent
BENCH_CMD := cd $(AGENT_DIR) && uv run opentraceai-bench
DATA_DIR  := data
WORK_DIR  := workdir

FIXTURES  := $(AGENT_DIR)/tests/fixtures
TASKS     := $(AGENT_DIR)/src/opentrace_agent/benchmarks/tasks

# Default backend for SWE-bench: claude-code or api
BACKEND   ?= claude-code
MODEL     ?= sonnet
# Set V=1 for verbose output (shows per-task results and index stats)
VERBOSE   := $(if $(V),-v,)
# Parallel workers for SWE-bench (default 1 = sequential)
WORKERS   ?= 1

.PHONY: help download accuracy accuracy-1 accuracy-2 accuracy-3 \
        swe-bench-smoke swe-bench-5 swe-bench compare clean

help:
	@echo "OpenTrace Benchmark Runner"
	@echo ""
	@echo "Setup:"
	@echo "  make download             Fetch SWE-bench Lite (300 instances)"
	@echo ""
	@echo "Graph Accuracy:"
	@echo "  make accuracy             Run all 3 levels"
	@echo "  make accuracy-1           Level 1 — single file (8 tasks)"
	@echo "  make accuracy-2           Level 2 — multi-file (16 tasks)"
	@echo "  make accuracy-3           Level 3 — polyglot (26 tasks)"
	@echo ""
	@echo "SWE-bench (requires: make download):"
	@echo "  make swe-bench-smoke      1 instance (sanity check)"
	@echo "  make swe-bench-5          5 instances from different repos"
	@echo "  make swe-bench            Full 300 instances"
	@echo "  make compare              A/B: with vs without OpenTrace (5 instances)"
	@echo ""
	@echo "Options (override with make VAR=val):"
	@echo "  V=1                       Verbose: show index stats + per-task results"
	@echo "  WORKERS=2                 Run N instances in parallel (default 1)"
	@echo "  BACKEND=claude-code       Agent backend (claude-code or api)"
	@echo "  MODEL=sonnet              Model to use"

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

download:
	cd $(AGENT_DIR) && uv run python ../benchmark/download_swe_bench.py

$(DATA_DIR)/swe_bench_lite.json: download

$(DATA_DIR)/swe_bench_lite_5.json: download

# ---------------------------------------------------------------------------
# Graph accuracy
# ---------------------------------------------------------------------------

accuracy: accuracy-1 accuracy-2 accuracy-3

accuracy-1:
	$(BENCH_CMD) accuracy $(VERBOSE) \
	  --codebase tests/fixtures/level1 --repo-id test/level1 \
	  $(TASKS)/level1_smoke.json

accuracy-2:
	$(BENCH_CMD) accuracy $(VERBOSE) \
	  --codebase tests/fixtures/level2 --repo-id test/level2 \
	  $(TASKS)/level2_multifile.json

accuracy-3:
	$(BENCH_CMD) accuracy $(VERBOSE) \
	  --codebase tests/fixtures/level3 --repo-id test/level3 \
	  $(TASKS)/level3_polyglot.json

# ---------------------------------------------------------------------------
# SWE-bench
# ---------------------------------------------------------------------------

swe-bench-smoke: $(DATA_DIR)/swe_bench_lite.json
	$(BENCH_CMD) swe-bench $(VERBOSE) \
	  ../benchmark/$(DATA_DIR)/swe_bench_lite.json \
	  --backend $(BACKEND) --model $(MODEL) -j $(WORKERS) \
	  --work-dir ../benchmark/$(WORK_DIR) \
	  --limit 1

swe-bench-5: $(DATA_DIR)/swe_bench_lite_5.json
	$(BENCH_CMD) swe-bench $(VERBOSE) \
	  ../benchmark/$(DATA_DIR)/swe_bench_lite_5.json \
	  --backend $(BACKEND) --model $(MODEL) -j $(WORKERS) \
	  --work-dir ../benchmark/$(WORK_DIR)

swe-bench: $(DATA_DIR)/swe_bench_lite.json
	$(BENCH_CMD) swe-bench $(VERBOSE) \
	  ../benchmark/$(DATA_DIR)/swe_bench_lite.json \
	  --backend $(BACKEND) --model $(MODEL) -j $(WORKERS) \
	  --work-dir ../benchmark/$(WORK_DIR)

compare: $(DATA_DIR)/swe_bench_lite_5.json
	$(BENCH_CMD) swe-bench $(VERBOSE) \
	  ../benchmark/$(DATA_DIR)/swe_bench_lite_5.json \
	  --backend $(BACKEND) --model $(MODEL) -j $(WORKERS) \
	  --work-dir ../benchmark/$(WORK_DIR) \
	  --compare --limit 5

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------

clean:
	rm -rf $(WORK_DIR)
	@echo "Cleaned workdir. Data preserved in $(DATA_DIR)/."

clean-all: clean
	rm -rf $(DATA_DIR)
	@echo "Cleaned data and workdir."
