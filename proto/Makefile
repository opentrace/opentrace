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

PROTO_DIR   := opentrace/v1
PROTO_FILES := $(PROTO_DIR)/job_config.proto $(PROTO_DIR)/agent_service.proto

# Code graph schema (protoc-gen-ladybug)
GRAPH_PROTO := $(PROTO_DIR)/code_graph.proto
GRAPH_OUT   := ../ui/src/gen

# TS and Python: protoc mirrors the proto package path (opentrace/v1/) under
# the output directory, so we point to the gen root.
TS_OUT     := ../ui/src/gen
PY_OUT     := ../agent/src/opentrace_agent/gen

TS_PROTO_PLUGIN := ../ui/node_modules/.bin/protoc-gen-ts_proto

# Go output uses module-relative paths so files land at pkg/gen/otv1/
GO_OUT     := ../api
GO_MODULE  := github.com/opentrace/opentrace/api

.PHONY: all ts go graph clean

all: ts go graph

ts:
	@mkdir -p $(TS_OUT)
	protoc \
		--proto_path=. \
		--plugin=protoc-gen-ts_proto=$(TS_PROTO_PLUGIN) \
		--ts_proto_out=$(TS_OUT) \
		--ts_proto_opt=onlyTypes=true \
		--ts_proto_opt=enumsAsLiterals=true \
		--ts_proto_opt=outputServices=false \
		--ts_proto_opt=esModuleInterop=true \
		$(PROTO_FILES)
	@# Flatten: protoc emits to <out>/opentrace/v1/ following the proto package
	@# path. We want the files at <out>/ — same convention as the rest of the
	@# UI gen surface (no per-version subfolder).
	@if [ -d $(TS_OUT)/opentrace/v1 ]; then mv $(TS_OUT)/opentrace/v1/*.ts $(TS_OUT)/ && rm -rf $(TS_OUT)/opentrace; fi

go:
	@mkdir -p $(GO_OUT)/pkg/gen/otv1
	protoc \
		--proto_path=. \
		--go_out=$(GO_OUT) \
		--go_opt=module=$(GO_MODULE) \
		--go-grpc_out=$(GO_OUT) \
		--go-grpc_opt=module=$(GO_MODULE) \
		$(PROTO_FILES)

graph:
	@mkdir -p $(GRAPH_OUT)
	protoc \
		--proto_path=. \
		--ladybug_out=$(GRAPH_OUT) \
		--ladybug_opt=lang=ts \
		$(GRAPH_PROTO)
	@# protoc-gen-ladybug mirrors the proto package path under the output dir.
	@# The codebase imports from the gen root, so copy it up.
	@cp $(GRAPH_OUT)/opentrace/v1/schema.gen.ts $(GRAPH_OUT)/schema.gen.ts
	@mkdir -p $(PY_OUT)
	protoc \
		--proto_path=. \
		--ladybug_out=$(PY_OUT) \
		--ladybug_opt=lang=py \
		$(GRAPH_PROTO)
	@# Flatten: protoc-gen-ladybug emits to <out>/opentrace/v1/ following the
	@# proto package path. Move the schema files up to <out>/ to match the
	@# rest of the gen surface (the codebase imports from the gen root).
	@if [ -d $(GRAPH_OUT)/opentrace/v1 ]; then mv $(GRAPH_OUT)/opentrace/v1/*.ts $(GRAPH_OUT)/ && rm -rf $(GRAPH_OUT)/opentrace; fi
	@if [ -d $(PY_OUT)/opentrace/v1 ]; then mv $(PY_OUT)/opentrace/v1/*.py $(PY_OUT)/ && rm -rf $(PY_OUT)/opentrace; fi

clean:
	rm -rf $(TS_OUT) $(PY_OUT)
