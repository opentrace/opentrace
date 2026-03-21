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

"""OpenTrace benchmarks — graph accuracy and SWE-bench evaluation."""

from opentrace_agent.benchmarks.graph_accuracy import GraphAccuracyBenchmark, TaskResult
from opentrace_agent.benchmarks.swe_bench import SWEBenchHarness

__all__ = ["GraphAccuracyBenchmark", "SWEBenchHarness", "TaskResult", "create_agent_fn"]


def create_agent_fn(**kwargs):  # noqa: ANN001, ANN003
    """Lazy import to avoid requiring anthropic at import time."""
    from opentrace_agent.benchmarks.agent import create_agent_fn as _create

    return _create(**kwargs)
