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
