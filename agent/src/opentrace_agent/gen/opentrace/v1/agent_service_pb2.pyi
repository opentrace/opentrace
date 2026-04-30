from opentrace_agent.gen.opentrace.v1 import job_config_pb2 as _job_config_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class JobPhase(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    JOB_PHASE_UNSPECIFIED: _ClassVar[JobPhase]
    JOB_PHASE_INITIALIZING: _ClassVar[JobPhase]
    JOB_PHASE_FETCHING: _ClassVar[JobPhase]
    JOB_PHASE_PARSING: _ClassVar[JobPhase]
    JOB_PHASE_RESOLVING: _ClassVar[JobPhase]
    JOB_PHASE_ENRICHING: _ClassVar[JobPhase]
    JOB_PHASE_SUBMITTING: _ClassVar[JobPhase]
    JOB_PHASE_DONE: _ClassVar[JobPhase]
    JOB_PHASE_SUMMARIZING: _ClassVar[JobPhase]
    JOB_PHASE_EMBEDDING: _ClassVar[JobPhase]
    JOB_PHASE_NORMALIZING: _ClassVar[JobPhase]
    JOB_PHASE_PLANNING: _ClassVar[JobPhase]
    JOB_PHASE_EXECUTING: _ClassVar[JobPhase]
    JOB_PHASE_PERSISTING: _ClassVar[JobPhase]

class JobEventKind(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    JOB_EVENT_KIND_UNSPECIFIED: _ClassVar[JobEventKind]
    JOB_EVENT_KIND_PROGRESS: _ClassVar[JobEventKind]
    JOB_EVENT_KIND_GRAPH_READY: _ClassVar[JobEventKind]
    JOB_EVENT_KIND_DONE: _ClassVar[JobEventKind]
    JOB_EVENT_KIND_ERROR: _ClassVar[JobEventKind]
    JOB_EVENT_KIND_STAGE_COMPLETE: _ClassVar[JobEventKind]
JOB_PHASE_UNSPECIFIED: JobPhase
JOB_PHASE_INITIALIZING: JobPhase
JOB_PHASE_FETCHING: JobPhase
JOB_PHASE_PARSING: JobPhase
JOB_PHASE_RESOLVING: JobPhase
JOB_PHASE_ENRICHING: JobPhase
JOB_PHASE_SUBMITTING: JobPhase
JOB_PHASE_DONE: JobPhase
JOB_PHASE_SUMMARIZING: JobPhase
JOB_PHASE_EMBEDDING: JobPhase
JOB_PHASE_NORMALIZING: JobPhase
JOB_PHASE_PLANNING: JobPhase
JOB_PHASE_EXECUTING: JobPhase
JOB_PHASE_PERSISTING: JobPhase
JOB_EVENT_KIND_UNSPECIFIED: JobEventKind
JOB_EVENT_KIND_PROGRESS: JobEventKind
JOB_EVENT_KIND_GRAPH_READY: JobEventKind
JOB_EVENT_KIND_DONE: JobEventKind
JOB_EVENT_KIND_ERROR: JobEventKind
JOB_EVENT_KIND_STAGE_COMPLETE: JobEventKind

class RunJobRequest(_message.Message):
    __slots__ = ("mcp_url", "api_key", "git_integrations")
    MCP_URL_FIELD_NUMBER: _ClassVar[int]
    API_KEY_FIELD_NUMBER: _ClassVar[int]
    GIT_INTEGRATIONS_FIELD_NUMBER: _ClassVar[int]
    mcp_url: str
    api_key: str
    git_integrations: _containers.RepeatedCompositeFieldContainer[_job_config_pb2.GitIntegrationConfig]
    def __init__(self, mcp_url: _Optional[str] = ..., api_key: _Optional[str] = ..., git_integrations: _Optional[_Iterable[_Union[_job_config_pb2.GitIntegrationConfig, _Mapping]]] = ...) -> None: ...

class IndexedNode(_message.Message):
    __slots__ = ("id", "type", "name", "properties_json")
    ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    PROPERTIES_JSON_FIELD_NUMBER: _ClassVar[int]
    id: str
    type: str
    name: str
    properties_json: str
    def __init__(self, id: _Optional[str] = ..., type: _Optional[str] = ..., name: _Optional[str] = ..., properties_json: _Optional[str] = ...) -> None: ...

class IndexedRelationship(_message.Message):
    __slots__ = ("id", "type", "source_id", "target_id", "properties_json")
    ID_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    SOURCE_ID_FIELD_NUMBER: _ClassVar[int]
    TARGET_ID_FIELD_NUMBER: _ClassVar[int]
    PROPERTIES_JSON_FIELD_NUMBER: _ClassVar[int]
    id: str
    type: str
    source_id: str
    target_id: str
    properties_json: str
    def __init__(self, id: _Optional[str] = ..., type: _Optional[str] = ..., source_id: _Optional[str] = ..., target_id: _Optional[str] = ..., properties_json: _Optional[str] = ...) -> None: ...

class JobEvent(_message.Message):
    __slots__ = ("kind", "phase", "message", "result", "errors", "detail", "nodes", "relationships")
    KIND_FIELD_NUMBER: _ClassVar[int]
    PHASE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    ERRORS_FIELD_NUMBER: _ClassVar[int]
    DETAIL_FIELD_NUMBER: _ClassVar[int]
    NODES_FIELD_NUMBER: _ClassVar[int]
    RELATIONSHIPS_FIELD_NUMBER: _ClassVar[int]
    kind: JobEventKind
    phase: JobPhase
    message: str
    result: JobResult
    errors: _containers.RepeatedScalarFieldContainer[str]
    detail: ProgressDetail
    nodes: _containers.RepeatedCompositeFieldContainer[IndexedNode]
    relationships: _containers.RepeatedCompositeFieldContainer[IndexedRelationship]
    def __init__(self, kind: _Optional[_Union[JobEventKind, str]] = ..., phase: _Optional[_Union[JobPhase, str]] = ..., message: _Optional[str] = ..., result: _Optional[_Union[JobResult, _Mapping]] = ..., errors: _Optional[_Iterable[str]] = ..., detail: _Optional[_Union[ProgressDetail, _Mapping]] = ..., nodes: _Optional[_Iterable[_Union[IndexedNode, _Mapping]]] = ..., relationships: _Optional[_Iterable[_Union[IndexedRelationship, _Mapping]]] = ...) -> None: ...

class ProgressDetail(_message.Message):
    __slots__ = ("current", "total", "file_name", "nodes_created", "relationships_created")
    CURRENT_FIELD_NUMBER: _ClassVar[int]
    TOTAL_FIELD_NUMBER: _ClassVar[int]
    FILE_NAME_FIELD_NUMBER: _ClassVar[int]
    NODES_CREATED_FIELD_NUMBER: _ClassVar[int]
    RELATIONSHIPS_CREATED_FIELD_NUMBER: _ClassVar[int]
    current: int
    total: int
    file_name: str
    nodes_created: int
    relationships_created: int
    def __init__(self, current: _Optional[int] = ..., total: _Optional[int] = ..., file_name: _Optional[str] = ..., nodes_created: _Optional[int] = ..., relationships_created: _Optional[int] = ...) -> None: ...

class JobResult(_message.Message):
    __slots__ = ("nodes_created", "relationships_created", "repos_processed")
    NODES_CREATED_FIELD_NUMBER: _ClassVar[int]
    RELATIONSHIPS_CREATED_FIELD_NUMBER: _ClassVar[int]
    REPOS_PROCESSED_FIELD_NUMBER: _ClassVar[int]
    nodes_created: int
    relationships_created: int
    repos_processed: int
    def __init__(self, nodes_created: _Optional[int] = ..., relationships_created: _Optional[int] = ..., repos_processed: _Optional[int] = ...) -> None: ...
