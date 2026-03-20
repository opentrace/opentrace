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

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/example/user-service/internal/db"
)

// -- constants --
const (
	contentTypeJSON = "application/json"
	maxBodySize     = 1 << 20 // 1 MB
)

// -- handler struct with unexported fields --
type Handler struct {
	store  db.Repository
	logger interface{ Printf(string, ...interface{}) }
}

// -- constructor --
func New(store db.Repository) *Handler {
	return &Handler{store: store}
}

// -- request/response types --
type createUserRequest struct {
	Name  string  `json:"name"`
	Email string  `json:"email"`
	Role  db.Role `json:"role"`
}

type updateUserRequest struct {
	Name  *string `json:"name,omitempty"`
	Email *string `json:"email,omitempty"`
	Role  *string `json:"role,omitempty"`
}

type errorResponse struct {
	Error   string `json:"error"`
	Code    int    `json:"code"`
}

// -- exported methods --
func (h *Handler) Users(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listUsers(w, r)
	case http.MethodPost:
		h.createUser(w, r)
	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Handler) UserByID(w http.ResponseWriter, r *http.Request) {
	idStr := strings.TrimPrefix(r.URL.Path, "/users/")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		writeError(w, "invalid user id", http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.getUser(w, id)
	case http.MethodPut:
		h.updateUser(w, r, id)
	case http.MethodDelete:
		h.deleteUser(w, id)
	default:
		writeError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	status := map[string]string{"status": "ok"}
	writeJSON(w, http.StatusOK, status)
}

// -- unexported methods (private) --
func (h *Handler) listUsers(w http.ResponseWriter, r *http.Request) {
	filter := db.UserFilter{ActiveOnly: r.URL.Query().Get("active") == "true"}

	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		limit, err := strconv.Atoi(limitStr)
		if err == nil {
			filter.Limit = limit
		}
	}

	users, err := h.store.GetAllUsers(filter)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (h *Handler) getUser(w http.ResponseWriter, id int64) {
	user, err := h.store.GetUserByID(id)
	if errors.Is(err, db.ErrUserNotFound) {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (h *Handler) createUser(w http.ResponseWriter, r *http.Request) {
	var input createUserRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodySize)).Decode(&input); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	role := input.Role
	if role == "" {
		role = db.RoleUser
	}

	user, err := h.store.InsertUser(input.Name, input.Email, role)
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (h *Handler) updateUser(w http.ResponseWriter, r *http.Request, id int64) {
	var input updateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, "invalid request body", http.StatusBadRequest)
		return
	}

	updates := make(map[string]interface{})
	if input.Name != nil {
		updates["name"] = *input.Name
	}
	if input.Email != nil {
		updates["email"] = *input.Email
	}
	if input.Role != nil {
		updates["role"] = *input.Role
	}

	user, err := h.store.UpdateUser(id, updates)
	if errors.Is(err, db.ErrUserNotFound) {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (h *Handler) deleteUser(w http.ResponseWriter, id int64) {
	err := h.store.DeleteUser(id)
	if errors.Is(err, db.ErrUserNotFound) {
		writeError(w, "user not found", http.StatusNotFound)
		return
	}
	if err != nil {
		writeError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// -- package-level helpers --
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", contentTypeJSON)
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, msg string, code int) {
	writeJSON(w, code, errorResponse{Error: msg, Code: code})
}
