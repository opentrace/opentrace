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

# TS and Python: protoc mirrors the proto package path (opentrace/v1/) under
# the output directory, so we point to the gen root.
TS_OUT     := ../ui/src/gen
PY_OUT     := ../agent/src/opentrace_agent/gen

TS_PROTO_PLUGIN := ../ui/node_modules/.bin/protoc-gen-ts_proto

# Go output uses module-relative paths so files land at pkg/gen/otv1/
GO_OUT     := ../api
GO_MODULE  := github.com/opentrace/opentrace/api

.PHONY: all ts py go clean

all: ts py go

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

py:
	@mkdir -p $(PY_OUT)
	python -m grpc_tools.protoc \
		--proto_path=. \
		--python_out=$(PY_OUT) \
		--pyi_out=$(PY_OUT) \
		--grpc_python_out=$(PY_OUT) \
		$(PROTO_FILES)
	@# Fix cross-file proto imports: generated code uses the proto package path
	@# (opentrace.v1) but the files live under opentrace_agent.gen.opentrace.v1.
	@find $(PY_OUT) -name '*.py' -exec \
		sed -i 's/from opentrace\.v1 import/from opentrace_agent.gen.opentrace.v1 import/g' {} +
	@find $(PY_OUT) -name '*.pyi' -exec \
		sed -i 's/from opentrace\.v1 import/from opentrace_agent.gen.opentrace.v1 import/g' {} +
	@touch $(PY_OUT)/opentrace/__init__.py
	@touch $(PY_OUT)/opentrace/v1/__init__.py

go:
	@mkdir -p $(GO_OUT)/pkg/gen/otv1
	protoc \
		--proto_path=. \
		--go_out=$(GO_OUT) \
		--go_opt=module=$(GO_MODULE) \
		--go-grpc_out=$(GO_OUT) \
		--go-grpc_opt=module=$(GO_MODULE) \
		$(PROTO_FILES)

clean:
	rm -rf $(TS_OUT) $(PY_OUT)
