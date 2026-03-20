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

package graph

import (
	"path"
	"strings"
)

// Builder accumulates nodes and relationships into a Batch.
// It deduplicates nodes by ID and auto-creates directory chains.
type Builder struct {
	repoID string
	nodes  map[string]Node
	rels   []Relationship
}

// NewBuilder creates a Builder for the given repository.
func NewBuilder(owner, repo string) *Builder {
	repoID := RepoID(owner, repo)
	b := &Builder{
		repoID: repoID,
		nodes:  make(map[string]Node),
	}
	// Always start with the Repository node
	b.addNode(Node{
		ID:   repoID,
		Type: TypeRepository,
		Name: repoID,
	})
	return b
}

func (b *Builder) addNode(n Node) {
	if _, exists := b.nodes[n.ID]; !exists {
		b.nodes[n.ID] = n
	}
}

func (b *Builder) addRel(r Relationship) {
	b.rels = append(b.rels, r)
}

// ensureDirChain creates Directory nodes and DEFINED_IN relationships
// for every segment of the given path.
func (b *Builder) ensureDirChain(dirPath string) {
	if dirPath == "" {
		return
	}
	dirID := DirID(b.repoID, dirPath)
	if _, exists := b.nodes[dirID]; exists {
		return
	}

	parent := path.Dir(dirPath)
	if parent == "." {
		parent = ""
	}
	b.ensureDirChain(parent)

	name := path.Base(dirPath)
	b.addNode(Node{
		ID:   dirID,
		Type: TypeDirectory,
		Name: name,
		Properties: map[string]any{
			"path": dirPath,
		},
	})

	targetID := b.repoID
	if parent != "" {
		targetID = DirID(b.repoID, parent)
	}
	b.addRel(Relationship{
		ID:       RelID(dirID, RelDefinedIn, targetID),
		Type:     RelDefinedIn,
		SourceID: dirID,
		TargetID: targetID,
	})
}

// AddFile adds a File node and its directory chain.
func (b *Builder) AddFile(filePath, language string, props map[string]any) string {
	fileID := FileID(b.repoID, filePath)
	ext := path.Ext(filePath)
	fileName := path.Base(filePath)

	p := map[string]any{
		"path":      filePath,
		"extension": ext,
	}
	if language != "" {
		p["language"] = language
	}
	for k, v := range props {
		p[k] = v
	}

	b.addNode(Node{
		ID:         fileID,
		Type:       TypeFile,
		Name:       fileName,
		Properties: p,
	})

	// Directory chain
	dir := path.Dir(filePath)
	if dir == "." {
		dir = ""
	}
	b.ensureDirChain(dir)

	parentID := b.repoID
	if dir != "" {
		parentID = DirID(b.repoID, dir)
	}
	b.addRel(Relationship{
		ID:       RelID(fileID, RelDefinedIn, parentID),
		Type:     RelDefinedIn,
		SourceID: fileID,
		TargetID: parentID,
	})

	return fileID
}

// AddFunction adds a Function node defined in the given parent (file or class).
func (b *Builder) AddFunction(parentID, name string, startLine, endLine int, props map[string]any) string {
	funcID := SymbolID(parentID, name)

	p := map[string]any{
		"start_line": startLine,
		"end_line":   endLine,
	}
	for k, v := range props {
		p[k] = v
	}

	b.addNode(Node{
		ID:         funcID,
		Type:       TypeFunction,
		Name:       name,
		Properties: p,
	})
	b.addRel(Relationship{
		ID:       RelID(funcID, RelDefinedIn, parentID),
		Type:     RelDefinedIn,
		SourceID: funcID,
		TargetID: parentID,
	})
	return funcID
}

// AddGoMethod adds a Go method node (with receiver type in the ID).
func (b *Builder) AddGoMethod(fileID, receiverType, name string, startLine, endLine int, props map[string]any) string {
	methodID := MethodID(fileID, receiverType, name)

	p := map[string]any{
		"start_line":    startLine,
		"end_line":      endLine,
		"language":      "go",
		"receiver_type": receiverType,
	}
	for k, v := range props {
		p[k] = v
	}

	b.addNode(Node{
		ID:         methodID,
		Type:       TypeFunction,
		Name:       name,
		Properties: p,
	})
	b.addRel(Relationship{
		ID:       RelID(methodID, RelDefinedIn, fileID),
		Type:     RelDefinedIn,
		SourceID: methodID,
		TargetID: fileID,
	})
	return methodID
}

// AddClass adds a Class node defined in the given file.
func (b *Builder) AddClass(fileID, name string, startLine, endLine int, props map[string]any) string {
	classID := SymbolID(fileID, name)

	p := map[string]any{
		"start_line": startLine,
		"end_line":   endLine,
	}
	for k, v := range props {
		p[k] = v
	}

	b.addNode(Node{
		ID:         classID,
		Type:       TypeClass,
		Name:       name,
		Properties: p,
	})
	b.addRel(Relationship{
		ID:       RelID(classID, RelDefinedIn, fileID),
		Type:     RelDefinedIn,
		SourceID: classID,
		TargetID: fileID,
	})
	return classID
}

// AddCall adds a CALLS relationship between two symbols.
func (b *Builder) AddCall(callerID, calleeID string, confidence float64) {
	b.addRel(Relationship{
		ID:       RelID(callerID, RelCalls, calleeID),
		Type:     RelCalls,
		SourceID: callerID,
		TargetID: calleeID,
		Properties: map[string]any{
			"confidence": confidence,
		},
	})
}

// AddImport adds an IMPORTS relationship from a file to another file or package.
func (b *Builder) AddImport(fileID, targetID string) {
	b.addRel(Relationship{
		ID:       RelID(fileID, RelImports, targetID),
		Type:     RelImports,
		SourceID: fileID,
		TargetID: targetID,
	})
}

// AddPackage adds a Package node and a DEPENDS_ON relationship from the repo.
func (b *Builder) AddPackage(registry, name, version string) string {
	pkgID := PackageID(registry, name)
	b.addNode(Node{
		ID:   pkgID,
		Type: TypePackage,
		Name: name,
		Properties: map[string]any{
			"registry": registry,
			"version":  version,
		},
	})
	b.addRel(Relationship{
		ID:       RelID(b.repoID, RelDependsOn, pkgID),
		Type:     RelDependsOn,
		SourceID: b.repoID,
		TargetID: pkgID,
		Properties: map[string]any{
			"version": version,
		},
	})
	return pkgID
}

// Build returns the accumulated Batch.
func (b *Builder) Build() Batch {
	nodes := make([]Node, 0, len(b.nodes))
	for _, n := range b.nodes {
		nodes = append(nodes, n)
	}
	return Batch{
		Nodes:         nodes,
		Relationships: b.rels,
	}
}

// --- Helpers ---

// DetectLanguage returns the language name for a file extension.
func DetectLanguage(filePath string) string {
	ext := strings.ToLower(path.Ext(filePath))
	switch ext {
	case ".go":
		return "go"
	case ".py":
		return "python"
	case ".ts", ".tsx":
		return "typescript"
	case ".js", ".jsx":
		return "javascript"
	case ".rs":
		return "rust"
	case ".java":
		return "java"
	case ".rb":
		return "ruby"
	case ".c", ".h":
		return "c"
	case ".cpp", ".hpp", ".cc":
		return "cpp"
	case ".cs":
		return "csharp"
	case ".kt":
		return "kotlin"
	case ".swift":
		return "swift"
	default:
		return ""
	}
}
