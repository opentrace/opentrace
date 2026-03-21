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

package handler

import "github.com/example/level3/store"

// Handler manages HTTP request handling.
type Handler struct {
	store *store.Store
}

// NewHandler creates a new Handler with an initialized store.
func NewHandler() *Handler {
	s := store.NewStore()
	s.Init()
	return &Handler{store: s}
}

// Start begins serving requests using data from the store.
func (h *Handler) Start() {
	items := h.store.All()
	for _, item := range items {
		println(item)
	}
}
