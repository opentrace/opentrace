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

package com.example.app

import java.sql.Connection
import java.sql.DriverManager
import java.sql.Statement
import kotlinx.serialization.Serializable

@Serializable
data class User(val id: Long, val name: String, val email: String)

@Serializable
data class CreateUserRequest(val name: String, val email: String)

class UserDatabase(private val jdbcUrl: String) {
    private lateinit var conn: Connection

    fun initialize() {
        conn = DriverManager.getConnection(jdbcUrl)
        conn.createStatement().execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE
            )
        """)
    }

    fun getAllUsers(): List<User> {
        val users = mutableListOf<User>()
        val rs = conn.createStatement().executeQuery("SELECT id, name, email FROM users")
        while (rs.next()) {
            users.add(User(rs.getLong("id"), rs.getString("name"), rs.getString("email")))
        }
        return users
    }

    fun insertUser(name: String, email: String): User {
        val ps = conn.prepareStatement(
            "INSERT INTO users (name, email) VALUES (?, ?)",
            Statement.RETURN_GENERATED_KEYS
        )
        ps.setString(1, name)
        ps.setString(2, email)
        ps.executeUpdate()
        val keys = ps.generatedKeys
        keys.next()
        return User(keys.getLong(1), name, email)
    }
}
