// Copyright 2026 OpenTrace Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Package graph provides types and helpers for building OpenTrace knowledge
// graphs. These types match the schema used by the OpenTrace pipeline
// (@opentrace/components/pipeline) and the graph store API.
package graph

import "fmt"

// --- Core types (match the pipeline's GraphNode / GraphRelationship) ---

// Node represents a single node in the knowledge graph.
type Node struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	Name       string         `json:"name"`
	Properties map[string]any `json:"properties,omitempty"`
}

// Relationship represents a directed edge in the knowledge graph.
type Relationship struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	SourceID   string         `json:"source_id"`
	TargetID   string         `json:"target_id"`
	Properties map[string]any `json:"properties,omitempty"`
}

// Batch is a collection of nodes and relationships for bulk import.
type Batch struct {
	Nodes         []Node         `json:"nodes"`
	Relationships []Relationship `json:"relationships"`
}

// BatchResult is the response from the import API.
type BatchResult struct {
	NodesCreated         int      `json:"nodes_created"`
	RelationshipsCreated int      `json:"relationships_created"`
	Errors               []string `json:"errors,omitempty"`
}

// --- Node types ---

const (
	TypeRepository = "Repository"
	TypeDirectory  = "Directory"
	TypeFile       = "File"
	TypeClass      = "Class"
	TypeFunction   = "Function"
	TypePackage    = "Package"
)

// --- Relationship types ---

const (
	RelDefinedIn = "DEFINED_IN"
	RelCalls     = "CALLS"
	RelImports   = "IMPORTS"
	RelDependsOn = "DEPENDS_ON"
)

// --- ID conventions ---
//
// Repository:  owner/repo                          (e.g. "myorg/myapp")
// Directory:   owner/repo/path                     (e.g. "myorg/myapp/internal/handler")
// File:        owner/repo/path/file                (e.g. "myorg/myapp/main.go")
// Class:       fileID::ClassName                   (e.g. "myorg/myapp/models.go::User")
// Function:    fileID::funcName                    (e.g. "myorg/myapp/main.go::main")
// Method:      classID::methodName                 (e.g. "myorg/myapp/models.go::User::Save")
// Go method:   fileID::ReceiverType.methodName     (e.g. "myorg/myapp/db.go::DB.Query")
// Package:     pkg:registry:name                   (e.g. "pkg:go:github.com/gin-gonic/gin")

// RepoID builds a repository node ID.
func RepoID(owner, repo string) string {
	return fmt.Sprintf("%s/%s", owner, repo)
}

// FileID builds a file node ID.
func FileID(repoID, path string) string {
	return fmt.Sprintf("%s/%s", repoID, path)
}

// DirID builds a directory node ID.
func DirID(repoID, path string) string {
	return fmt.Sprintf("%s/%s", repoID, path)
}

// SymbolID builds a class or function node ID.
func SymbolID(parentID, name string) string {
	return fmt.Sprintf("%s::%s", parentID, name)
}

// MethodID builds a Go-style method node ID (ReceiverType.methodName).
func MethodID(fileID, receiverType, methodName string) string {
	return fmt.Sprintf("%s::%s.%s", fileID, receiverType, methodName)
}

// PackageID builds a package node ID.
func PackageID(registry, name string) string {
	return fmt.Sprintf("pkg:%s:%s", registry, name)
}

// RelID builds a deterministic relationship ID.
func RelID(sourceID, relType, targetID string) string {
	return fmt.Sprintf("%s->%s->%s", sourceID, relType, targetID)
}
