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
