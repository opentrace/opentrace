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

package db

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// -- package-level constants and variables --
const (
	TableName      = "users"
	DefaultRole    = "user"
	MaxPageSize    = 100
	schemaVersion  = 2
)

var (
	ErrUserNotFound = errors.New("user not found")
	ErrDuplicateEmail = errors.New("duplicate email")
)

// -- type definitions --
type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

type User struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Email     string    `json:"email"`
	Role      Role      `json:"role"`
	Active    bool      `json:"active"`
	CreatedAt time.Time `json:"created_at"`
}

type UserFilter struct {
	Role       *Role
	ActiveOnly bool
	Limit      int
	Offset     int
}

// -- interface --
type Repository interface {
	GetAllUsers(filter UserFilter) ([]User, error)
	GetUserByID(id int64) (*User, error)
	InsertUser(name, email string, role Role) (*User, error)
	UpdateUser(id int64, updates map[string]interface{}) (*User, error)
	DeleteUser(id int64) error
	CountUsers() (int, error)
}

// -- Store (unexported conn = private field) --
type Store struct {
	conn          *sql.DB
	readOnly      bool
	maxRetries    int
	schemaVersion int
}

// -- exported constructor --
func New(path string) (*Store, error) {
	return NewWithOptions(path, false)
}

func NewReadOnly(path string) (*Store, error) {
	return NewWithOptions(path, true)
}

func NewWithOptions(path string, readOnly bool) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?mode=%s", path, func() string {
		if readOnly {
			return "ro"
		}
		return "rwc"
	}())
	conn, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	s := &Store{
		conn:          conn,
		readOnly:      readOnly,
		maxRetries:    3,
		schemaVersion: schemaVersion,
	}

	if !readOnly {
		if err := s.migrate(); err != nil {
			conn.Close()
			return nil, err
		}
	}
	return s, nil
}

// -- private methods --
func (s *Store) migrate() error {
	query := fmt.Sprintf(`
		CREATE TABLE IF NOT EXISTS %s (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			email TEXT NOT NULL UNIQUE,
			role TEXT NOT NULL DEFAULT '%s',
			active INTEGER NOT NULL DEFAULT 1,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`, TableName, DefaultRole)
	_, err := s.conn.Exec(query)
	return err
}

// -- exported methods (various parameter patterns) --
func (s *Store) GetAllUsers(filter UserFilter) ([]User, error) {
	query := fmt.Sprintf("SELECT id, name, email, role, active, created_at FROM %s WHERE 1=1", TableName)
	var args []interface{}

	if filter.Role != nil {
		query += " AND role = ?"
		args = append(args, string(*filter.Role))
	}
	if filter.ActiveOnly {
		query += " AND active = 1"
	}

	limit := filter.Limit
	if limit <= 0 || limit > MaxPageSize {
		limit = MaxPageSize
	}
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, filter.Offset)

	rows, err := s.conn.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query users: %w", err)
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		var roleStr string
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &roleStr, &u.Active, &u.CreatedAt); err != nil {
			return nil, err
		}
		u.Role = Role(roleStr)
		users = append(users, u)
	}
	return users, rows.Err()
}

func (s *Store) GetUserByID(id int64) (*User, error) {
	var u User
	var roleStr string
	err := s.conn.QueryRow(
		fmt.Sprintf("SELECT id, name, email, role, active, created_at FROM %s WHERE id = ?", TableName),
		id,
	).Scan(&u.ID, &u.Name, &u.Email, &roleStr, &u.Active, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	u.Role = Role(roleStr)
	return &u, nil
}

func (s *Store) InsertUser(name, email string, role Role) (*User, error) {
	result, err := s.conn.Exec(
		fmt.Sprintf("INSERT INTO %s (name, email, role) VALUES (?, ?, ?)", TableName),
		name, email, string(role),
	)
	if err != nil {
		return nil, fmt.Errorf("insert user: %w", err)
	}
	id, _ := result.LastInsertId()
	now := time.Now()
	return &User{ID: id, Name: name, Email: email, Role: role, Active: true, CreatedAt: now}, nil
}

func (s *Store) UpdateUser(id int64, updates map[string]interface{}) (*User, error) {
	// verify exists
	if _, err := s.GetUserByID(id); err != nil {
		return nil, err
	}
	for key, value := range updates {
		query := fmt.Sprintf("UPDATE %s SET %s = ? WHERE id = ?", TableName, key)
		if _, err := s.conn.Exec(query, value, id); err != nil {
			return nil, err
		}
	}
	return s.GetUserByID(id)
}

func (s *Store) DeleteUser(id int64) error {
	result, err := s.conn.Exec(
		fmt.Sprintf("DELETE FROM %s WHERE id = ?", TableName),
		id,
	)
	if err != nil {
		return err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return ErrUserNotFound
	}
	return nil
}

func (s *Store) CountUsers() (int, error) {
	var count int
	err := s.conn.QueryRow(fmt.Sprintf("SELECT COUNT(*) FROM %s", TableName)).Scan(&count)
	return count, err
}

func (s *Store) Close() error {
	return s.conn.Close()
}
