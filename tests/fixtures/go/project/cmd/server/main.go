package main

import (
	"log"
	"net/http"

	"github.com/example/user-service/internal/db"
	"github.com/example/user-service/internal/handler"
)

func main() {
	store, err := db.New("app.db")
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	h := handler.New(store)

	http.HandleFunc("/users", h.Users)

	log.Println("Server running on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
