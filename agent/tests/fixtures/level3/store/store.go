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
