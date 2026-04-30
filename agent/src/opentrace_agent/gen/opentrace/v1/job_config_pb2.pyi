from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class GitProvider(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    GIT_PROVIDER_UNSPECIFIED: _ClassVar[GitProvider]
    GIT_PROVIDER_GITHUB: _ClassVar[GitProvider]
    GIT_PROVIDER_GITLAB: _ClassVar[GitProvider]
GIT_PROVIDER_UNSPECIFIED: GitProvider
GIT_PROVIDER_GITHUB: GitProvider
GIT_PROVIDER_GITLAB: GitProvider

class GitIntegrationConfig(_message.Message):
    __slots__ = ("id", "repo_url", "ref", "personal_access_token", "provider", "display_name", "created_at")
    ID_FIELD_NUMBER: _ClassVar[int]
    REPO_URL_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    PERSONAL_ACCESS_TOKEN_FIELD_NUMBER: _ClassVar[int]
    PROVIDER_FIELD_NUMBER: _ClassVar[int]
    DISPLAY_NAME_FIELD_NUMBER: _ClassVar[int]
    CREATED_AT_FIELD_NUMBER: _ClassVar[int]
    id: str
    repo_url: str
    ref: str
    personal_access_token: str
    provider: GitProvider
    display_name: str
    created_at: int
    def __init__(self, id: _Optional[str] = ..., repo_url: _Optional[str] = ..., ref: _Optional[str] = ..., personal_access_token: _Optional[str] = ..., provider: _Optional[_Union[GitProvider, str]] = ..., display_name: _Optional[str] = ..., created_at: _Optional[int] = ...) -> None: ...

class CreateGitIntegrationRequest(_message.Message):
    __slots__ = ("repo_url", "ref", "personal_access_token")
    REPO_URL_FIELD_NUMBER: _ClassVar[int]
    REF_FIELD_NUMBER: _ClassVar[int]
    PERSONAL_ACCESS_TOKEN_FIELD_NUMBER: _ClassVar[int]
    repo_url: str
    ref: str
    personal_access_token: str
    def __init__(self, repo_url: _Optional[str] = ..., ref: _Optional[str] = ..., personal_access_token: _Optional[str] = ...) -> None: ...

class CreateGitIntegrationResponse(_message.Message):
    __slots__ = ("integration",)
    INTEGRATION_FIELD_NUMBER: _ClassVar[int]
    integration: GitIntegrationConfig
    def __init__(self, integration: _Optional[_Union[GitIntegrationConfig, _Mapping]] = ...) -> None: ...

class ListGitIntegrationsResponse(_message.Message):
    __slots__ = ("integrations",)
    INTEGRATIONS_FIELD_NUMBER: _ClassVar[int]
    integrations: _containers.RepeatedCompositeFieldContainer[GitIntegrationConfig]
    def __init__(self, integrations: _Optional[_Iterable[_Union[GitIntegrationConfig, _Mapping]]] = ...) -> None: ...
