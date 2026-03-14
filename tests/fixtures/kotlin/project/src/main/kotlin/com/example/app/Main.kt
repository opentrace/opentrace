package com.example.app

import io.ktor.http.*
import io.ktor.serialization.kotlinx.json.*
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.plugins.contentnegotiation.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

fun main() {
    val db = UserDatabase("jdbc:sqlite:app.db")
    db.initialize()

    embeddedServer(Netty, port = 8080) {
        install(ContentNegotiation) {
            json()
        }
        routing {
            get("/users") {
                val users = db.getAllUsers()
                call.respond(users)
            }
            post("/users") {
                val input = call.receive<CreateUserRequest>()
                val user = db.insertUser(input.name, input.email)
                call.respond(HttpStatusCode.Created, user)
            }
        }
    }.start(wait = true)
}
