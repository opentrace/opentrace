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

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/example/user-service/internal/db"
	"github.com/example/user-service/internal/handler"
)

// -- package constants --
const (
	defaultPort         = ":8080"
	defaultDBPath       = "app.db"
	shutdownTimeout     = 5 * time.Second
	readTimeout         = 10 * time.Second
	writeTimeout        = 15 * time.Second
)

// -- package variables --
var version = "dev"

func main() {
	port := getEnvOrDefault("PORT", defaultPort)
	dbPath := getEnvOrDefault("DB_PATH", defaultDBPath)

	store, err := db.New(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	h := handler.New(store)
	mux := http.NewServeMux()
	mux.HandleFunc("/users", h.Users)
	mux.HandleFunc("/users/", h.UserByID)
	mux.HandleFunc("/health", h.Health)

	srv := &http.Server{
		Addr:         port,
		Handler:      mux,
		ReadTimeout:  readTimeout,
		WriteTimeout: writeTimeout,
	}

	// graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("Server %s listening on %s", version, port)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := <-done
	log.Printf("Received signal %v, shutting down", sig)

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("shutdown: %v", err)
	}
}

func getEnvOrDefault(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok {
		return val
	}
	return fallback
}
