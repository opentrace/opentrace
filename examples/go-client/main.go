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

// Example: build a knowledge graph from a Go project and load it into OpenTrace.
//
// This demonstrates how to use the OpenTrace graph schema to model a codebase
// as nodes (Repository, File, Function, Class, Package) and relationships
// (DEFINED_IN, CALLS, IMPORTS, DEPENDS_ON).
//
// Usage:
//
//	# Print the graph as JSON (no server needed)
//	go run . --print
//
//	# Load into a running OpenTrace instance
//	go run . --url http://localhost:5173
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/opentrace/opentrace/examples/go-client/graph"
)

func main() {
	printJSON := flag.Bool("print", false, "print the graph batch as JSON instead of loading")
	apiURL := flag.String("url", "http://localhost:5173", "OpenTrace API base URL")
	flag.Parse()

	batch := buildExampleGraph()

	if *printJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(batch); err != nil {
			log.Fatal(err)
		}
		fmt.Fprintf(os.Stderr, "\n%d nodes, %d relationships\n", len(batch.Nodes), len(batch.Relationships))
		return
	}

	// Load into OpenTrace
	client := graph.NewClient(*apiURL)
	result, err := client.ImportBatch(context.Background(), batch)
	if err != nil {
		log.Fatalf("import failed: %v", err)
	}
	fmt.Printf("Imported %d nodes, %d relationships\n", result.NodesCreated, result.RelationshipsCreated)
	if len(result.Errors) > 0 {
		for _, e := range result.Errors {
			fmt.Printf("  error: %s\n", e)
		}
	}
}

// buildExampleGraph models a small Go microservice as an OpenTrace knowledge graph.
// This is equivalent to what the TypeScript pipeline produces when it parses a repo.
func buildExampleGraph() graph.Batch {
	b := graph.NewBuilder("example", "user-service")

	// --- Dependencies (from go.mod) ---

	ginPkg := b.AddPackage("go", "github.com/gin-gonic/gin", "v1.10.0")
	gormPkg := b.AddPackage("go", "gorm.io/gorm", "v1.25.12")
	b.AddPackage("go", "gorm.io/driver/postgres", "v1.5.11")

	// --- Files ---

	mainFile := b.AddFile("cmd/server/main.go", "go", map[string]any{
		"summary": "Application entry point — starts the HTTP server",
	})

	handlerFile := b.AddFile("internal/handler/handler.go", "go", map[string]any{
		"summary": "HTTP request handlers for the user API",
	})

	modelFile := b.AddFile("internal/model/user.go", "go", map[string]any{
		"summary": "User data model and database schema",
	})

	repoFile := b.AddFile("internal/repo/user.go", "go", map[string]any{
		"summary": "Database operations for the User model",
	})

	b.AddFile("go.mod", "", map[string]any{
		"summary": "Go module definition and dependencies",
	})

	// --- Symbols in cmd/server/main.go ---

	mainFn := b.AddFunction(mainFile, "main", 12, 28, map[string]any{
		"language":  "go",
		"signature": "func main()",
		"summary":   "Initializes database, creates router, registers routes, and starts server",
	})

	setupRoutes := b.AddFunction(mainFile, "setupRoutes", 30, 38, map[string]any{
		"language":  "go",
		"signature": "func setupRoutes(r *gin.Engine, h *Handler)",
		"summary":   "Registers HTTP routes on the Gin router",
	})

	// --- Symbols in internal/handler/handler.go ---

	handlerStruct := b.AddClass(handlerFile, "Handler", 10, 13, map[string]any{
		"language": "go",
		"subtype":  "struct",
		"summary":  "HTTP handler with a UserRepo dependency",
	})

	newHandler := b.AddFunction(handlerFile, "NewHandler", 15, 19, map[string]any{
		"language":  "go",
		"signature": "func NewHandler(repo *UserRepo) *Handler",
		"summary":   "Creates a new Handler with the given repository",
	})

	listUsers := b.AddGoMethod(handlerFile, "Handler", "ListUsers", 21, 35, map[string]any{
		"signature": "(h *Handler) ListUsers(c *gin.Context)",
		"summary":   "Handles GET /users — returns all users as JSON",
	})

	createUser := b.AddGoMethod(handlerFile, "Handler", "CreateUser", 37, 58, map[string]any{
		"signature": "(h *Handler) CreateUser(c *gin.Context)",
		"summary":   "Handles POST /users — creates a new user from request body",
	})

	getUser := b.AddGoMethod(handlerFile, "Handler", "GetUser", 60, 78, map[string]any{
		"signature": "(h *Handler) GetUser(c *gin.Context)",
		"summary":   "Handles GET /users/:id — returns a single user by ID",
	})

	// --- Symbols in internal/model/user.go ---

	userModel := b.AddClass(modelFile, "User", 8, 15, map[string]any{
		"language": "go",
		"subtype":  "struct",
		"summary":  "User entity with GORM annotations for PostgreSQL",
	})

	// --- Symbols in internal/repo/user.go ---

	userRepo := b.AddClass(repoFile, "UserRepo", 10, 13, map[string]any{
		"language": "go",
		"subtype":  "struct",
		"summary":  "Repository for database operations on the User model",
	})

	findAll := b.AddGoMethod(repoFile, "UserRepo", "FindAll", 15, 22, map[string]any{
		"signature": "(r *UserRepo) FindAll(ctx context.Context) ([]User, error)",
		"summary":   "Retrieves all users from the database",
	})

	create := b.AddGoMethod(repoFile, "UserRepo", "Create", 24, 30, map[string]any{
		"signature": "(r *UserRepo) Create(ctx context.Context, user *User) error",
		"summary":   "Inserts a new user into the database",
	})

	findByID := b.AddGoMethod(repoFile, "UserRepo", "FindByID", 32, 42, map[string]any{
		"signature": "(r *UserRepo) FindByID(ctx context.Context, id uint) (*User, error)",
		"summary":   "Retrieves a single user by primary key",
	})

	// --- CALLS relationships ---

	b.AddCall(mainFn, setupRoutes, 1.0)   // main() calls setupRoutes()
	b.AddCall(mainFn, newHandler, 1.0)     // main() calls NewHandler()
	b.AddCall(setupRoutes, listUsers, 0.9) // setupRoutes registers ListUsers handler
	b.AddCall(setupRoutes, createUser, 0.9)
	b.AddCall(setupRoutes, getUser, 0.9)
	b.AddCall(listUsers, findAll, 1.0) // ListUsers calls repo.FindAll
	b.AddCall(createUser, create, 1.0) // CreateUser calls repo.Create
	b.AddCall(getUser, findByID, 1.0)  // GetUser calls repo.FindByID

	// --- IMPORTS relationships ---

	b.AddImport(mainFile, handlerFile)
	b.AddImport(mainFile, repoFile)
	b.AddImport(handlerFile, modelFile)
	b.AddImport(handlerFile, repoFile)
	b.AddImport(repoFile, modelFile)

	// File → Package imports
	b.AddImport(mainFile, ginPkg)
	b.AddImport(handlerFile, ginPkg)
	b.AddImport(repoFile, gormPkg)

	_ = userModel   // referenced by imports
	_ = handlerStruct
	_ = userRepo

	return b.Build()
}
