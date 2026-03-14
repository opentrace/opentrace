package db

import (
	"database/sql"

	_ "github.com/mattn/go-sqlite3"
)

type User struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Store struct {
	conn *sql.DB
}

func New(path string) (*Store, error) {
	conn, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, err
	}
	_, err = conn.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			email TEXT NOT NULL UNIQUE
		)
	`)
	if err != nil {
		return nil, err
	}
	return &Store{conn: conn}, nil
}

func (s *Store) GetAllUsers() ([]User, error) {
	rows, err := s.conn.Query("SELECT id, name, email FROM users")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Name, &u.Email); err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, nil
}

func (s *Store) InsertUser(name, email string) (*User, error) {
	result, err := s.conn.Exec(
		"INSERT INTO users (name, email) VALUES (?, ?)",
		name, email,
	)
	if err != nil {
		return nil, err
	}
	id, _ := result.LastInsertId()
	return &User{ID: id, Name: name, Email: email}, nil
}

func (s *Store) Close() error {
	return s.conn.Close()
}
