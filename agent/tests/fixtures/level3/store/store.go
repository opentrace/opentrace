package store

// Store manages data persistence.
type Store struct {
	data []string
}

// NewStore creates a new empty Store.
func NewStore() *Store {
	return &Store{data: []string{}}
}

// Init seeds the store with default data.
func (s *Store) Init() {
	s.data = []string{"item1", "item2", "item3"}
}

// All returns all items in the store.
func (s *Store) All() []string {
	return s.data
}
