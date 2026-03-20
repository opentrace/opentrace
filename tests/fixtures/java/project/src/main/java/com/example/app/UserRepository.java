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

import java.sql.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;

public class UserRepository implements AutoCloseable {
    // -- constants --
    private static final String TABLE_NAME = "users";
    private static final int MAX_PAGE_SIZE = 100;
    private static final int DEFAULT_PAGE_SIZE = 20;

    // -- fields --
    private final Connection conn;
    private final boolean readOnly;

    // -- constructor --
    public UserRepository(String jdbcUrl) throws SQLException {
        this(jdbcUrl, false);
    }

    public UserRepository(String jdbcUrl, boolean readOnly) throws SQLException {
        this.readOnly = readOnly;
        this.conn = DriverManager.getConnection(jdbcUrl);
    }

    // -- schema --
    public void initialize() throws SQLException {
        if (readOnly) return;
        try (Statement stmt = conn.createStatement()) {
            stmt.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    role TEXT NOT NULL DEFAULT 'user',
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            """);
        }
    }

    // -- CRUD (various parameter patterns) --
    public List<User> getAllUsers() throws SQLException {
        return getAllUsers(null, DEFAULT_PAGE_SIZE, 0);
    }

    public List<User> getAllUsers(String role, int limit, int offset) throws SQLException {
        int effectiveLimit = Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
        StringBuilder sql = new StringBuilder("SELECT id, name, email, role, active, created_at FROM ");
        sql.append(TABLE_NAME);
        List<Object> params = new ArrayList<>();

        if (role != null) {
            sql.append(" WHERE role = ?");
            params.add(role);
        }
        sql.append(" LIMIT ? OFFSET ?");
        params.add(effectiveLimit);
        params.add(offset);

        try (PreparedStatement ps = conn.prepareStatement(sql.toString())) {
            for (int i = 0; i < params.size(); i++) {
                ps.setObject(i + 1, params.get(i));
            }
            try (ResultSet rs = ps.executeQuery()) {
                List<User> users = new ArrayList<>();
                while (rs.next()) {
                    users.add(rowToUser(rs));
                }
                return Collections.unmodifiableList(users);
            }
        }
    }

    public Optional<User> getUserById(long id) throws SQLException {
        String sql = "SELECT id, name, email, role, active, created_at FROM " + TABLE_NAME + " WHERE id = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                if (rs.next()) {
                    return Optional.of(rowToUser(rs));
                }
                return Optional.empty();
            }
        }
    }

    public User insertUser(String name, String email) throws SQLException {
        return insertUser(name, email, User.DEFAULT_ROLE);
    }

    public User insertUser(String name, String email, String role) throws SQLException {
        String sql = "INSERT INTO " + TABLE_NAME + " (name, email, role) VALUES (?, ?, ?)";
        try (PreparedStatement ps = conn.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) {
            ps.setString(1, name);
            ps.setString(2, email);
            ps.setString(3, role);
            ps.executeUpdate();
            try (ResultSet keys = ps.getGeneratedKeys()) {
                keys.next();
                long newId = keys.getLong(1);
                return new User(newId, name, email, role);
            }
        }
    }

    public boolean deleteUser(long id) throws SQLException {
        String sql = "DELETE FROM " + TABLE_NAME + " WHERE id = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setLong(1, id);
            int affected = ps.executeUpdate();
            return affected > 0;
        }
    }

    public int countUsers() throws SQLException {
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery("SELECT COUNT(*) FROM " + TABLE_NAME)) {
            rs.next();
            return rs.getInt(1);
        }
    }

    // -- JSON helpers --
    public String getAllUsersAsJson() throws SQLException {
        List<User> users = getAllUsers();
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < users.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(users.get(i).toJson());
        }
        sb.append("]");
        return sb.toString();
    }

    public String insertUserFromJson(String json) throws SQLException {
        String name = extractJsonField(json, "name");
        String email = extractJsonField(json, "email");
        String role = extractJsonFieldOrDefault(json, "role", User.DEFAULT_ROLE);
        User user = insertUser(name, email, role);
        return user.toJson();
    }

    // -- private helpers --
    private User rowToUser(ResultSet rs) throws SQLException {
        long id = rs.getLong("id");
        String name = rs.getString("name");
        String email = rs.getString("email");
        String role = rs.getString("role");
        boolean active = rs.getInt("active") == 1;
        Instant createdAt = Instant.parse(rs.getString("created_at") + "Z");
        return new User(id, name, email, role, active, createdAt);
    }

    private String extractJsonField(String json, String field) {
        int idx = json.indexOf("\"" + field + "\"");
        if (idx < 0) throw new IllegalArgumentException("Missing field: " + field);
        int start = json.indexOf("\"", idx + field.length() + 2) + 1;
        int end = json.indexOf("\"", start);
        return json.substring(start, end);
    }

    private String extractJsonFieldOrDefault(String json, String field, String defaultValue) {
        try {
            return extractJsonField(json, field);
        } catch (IllegalArgumentException e) {
            return defaultValue;
        }
    }

    // -- AutoCloseable --
    @Override
    public void close() throws SQLException {
        conn.close();
    }
}
