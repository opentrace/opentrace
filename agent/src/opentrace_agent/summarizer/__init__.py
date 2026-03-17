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

"""Summarizer abstraction and implementations for node summarization."""

from opentrace_agent.summarizer.base import NodeKind, Summarizer, SummarizerConfig
from opentrace_agent.summarizer.flan_t5 import FlanT5Summarizer

__all__ = [
    "FlanT5Summarizer",
    "NodeKind",
    "Summarizer",
    "SummarizerConfig",
]
