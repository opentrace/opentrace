#!/usr/bin/env python3
"""Download SWE-bench Lite dataset from HuggingFace.

Fetches the parquet file and converts to JSON. No auth required.
Outputs: benchmark/data/swe_bench_lite.json (300 instances)
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

PARQUET_URL = (
    "https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite"
    "/resolve/refs%2Fconvert%2Fparquet/default/test/0000.parquet"
)

DATA_DIR = Path(__file__).parent / "data"
PARQUET_PATH = DATA_DIR / "swe_bench_lite.parquet"
JSON_PATH = DATA_DIR / "swe_bench_lite.json"


def download_parquet() -> None:
    """Download the parquet file from HuggingFace."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if PARQUET_PATH.exists():
        print(f"Already downloaded: {PARQUET_PATH}")
        return

    print(f"Downloading SWE-bench Lite from HuggingFace...")
    urllib.request.urlretrieve(PARQUET_URL, PARQUET_PATH)
    size_mb = PARQUET_PATH.stat().st_size / 1024 / 1024
    print(f"Downloaded: {PARQUET_PATH} ({size_mb:.1f} MB)")


def convert_to_json() -> None:
    """Convert parquet to JSON."""
    if JSON_PATH.exists():
        # Check if it's newer than parquet
        if JSON_PATH.stat().st_mtime >= PARQUET_PATH.stat().st_mtime:
            instances = json.loads(JSON_PATH.read_text())
            print(f"Already converted: {JSON_PATH} ({len(instances)} instances)")
            return

    try:
        import pandas as pd
    except ImportError:
        print(
            "Error: pandas is required for parquet conversion.\n"
            "Install with: pip install pandas pyarrow\n"
            "Or: uv pip install pandas pyarrow",
            file=sys.stderr,
        )
        sys.exit(1)

    print("Converting parquet to JSON...")
    df = pd.read_parquet(PARQUET_PATH)
    df.to_json(JSON_PATH, orient="records", indent=2)
    print(f"Written: {JSON_PATH} ({len(df)} instances)")


def make_small_subset() -> None:
    """Create a 5-instance subset for quick testing."""
    subset_path = DATA_DIR / "swe_bench_lite_5.json"
    if subset_path.exists():
        return

    instances = json.loads(JSON_PATH.read_text())
    # Pick instances from different repos for variety
    seen_repos: set[str] = set()
    subset: list[dict] = []
    for inst in instances:
        repo = inst["repo"]
        if repo not in seen_repos and len(subset) < 5:
            subset.append(inst)
            seen_repos.add(repo)

    subset_path.write_text(json.dumps(subset, indent=2))
    repos = [s["repo"] for s in subset]
    print(f"Created 5-instance subset: {subset_path}")
    print(f"  Repos: {', '.join(repos)}")


def main() -> None:
    download_parquet()
    convert_to_json()
    make_small_subset()
    print("\nReady! Run benchmarks with:")
    print(f"  make swe-bench-smoke    # 1 instance, quick sanity check")
    print(f"  make swe-bench-5        # 5 instances from different repos")
    print(f"  make swe-bench          # full 300 instances")


if __name__ == "__main__":
    main()
