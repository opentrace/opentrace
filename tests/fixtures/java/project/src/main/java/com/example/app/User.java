package com.example.app;

public class User {
    private final long id;
    private final String name;
    private final String email;

    public User(long id, String name, String email) {
        this.id = id;
        this.name = name;
        this.email = email;
    }

    public long getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getEmail() {
        return email;
    }

    public String toJson() {
        return String.format("{\"id\":%d,\"name\":\"%s\",\"email\":\"%s\"}", id, name, email);
    }
}
