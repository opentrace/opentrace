/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.example.app;

import java.time.Instant;
import java.util.Objects;

public class User {
    // -- constants --
    public static final String DEFAULT_ROLE = "user";
    private static final int MAX_NAME_LENGTH = 255;

    // -- instance fields (various visibility) --
    private final long id;
    private final String name;
    private final String email;
    private String role;
    private boolean active;
    private final Instant createdAt;

    // -- static field --
    private static int instanceCount = 0;

    // -- constructors (overloaded) --
    public User(long id, String name, String email) {
        this(id, name, email, DEFAULT_ROLE, true, Instant.now());
    }

    public User(long id, String name, String email, String role) {
        this(id, name, email, role, true, Instant.now());
    }

    public User(long id, String name, String email, String role, boolean active, Instant createdAt) {
        if (name.length() > MAX_NAME_LENGTH) {
            throw new IllegalArgumentException("Name too long");
        }
        this.id = id;
        this.name = name;
        this.email = email;
        this.role = role;
        this.active = active;
        this.createdAt = createdAt;
        instanceCount++;
    }

    // -- getters (public) --
    public long getId() { return id; }
    public String getName() { return name; }
    public String getEmail() { return email; }
    public String getRole() { return role; }
    public boolean isActive() { return active; }
    public Instant getCreatedAt() { return createdAt; }

    // -- setters (mutable fields only) --
    public void setRole(String role) { this.role = role; }
    public void setActive(boolean active) { this.active = active; }

    // -- static method --
    public static int getInstanceCount() { return instanceCount; }

    // -- business logic --
    public boolean isAdmin() {
        return "admin".equals(this.role);
    }

    // -- serialization --
    public String toJson() {
        return String.format(
            "{\"id\":%d,\"name\":\"%s\",\"email\":\"%s\",\"role\":\"%s\",\"active\":%b}",
            id, name, email, role, active
        );
    }

    // -- Object overrides --
    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof User other)) return false;
        return id == other.id && Objects.equals(email, other.email);
    }

    @Override
    public int hashCode() {
        return Objects.hash(id, email);
    }

    @Override
    public String toString() {
        return String.format("User{id=%d, name='%s', email='%s', role='%s'}", id, name, email, role);
    }
}
