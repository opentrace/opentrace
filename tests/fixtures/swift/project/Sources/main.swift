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

import Vapor
import Fluent
import FluentSQLiteDriver

// -- constants --
let defaultPort: Int = 8080
let apiVersion: String = "v1"

// -- configuration --
struct AppConfig {
    let port: Int
    let dbPath: String
    let debug: Bool

    static let `default` = AppConfig(port: defaultPort, dbPath: "app.db", debug: false)
}

func configure(_ app: Application, config: AppConfig = .default) async throws {
    app.databases.use(.sqlite(.file(config.dbPath)), as: .sqlite)
    app.migrations.add(CreateUser())
    try await app.autoMigrate()

    // -- list users --
    app.get("users") { req async throws -> [User] in
        let activeOnly: Bool = req.query["active"] ?? false
        var query = User.query(on: req.db)
        if activeOnly {
            query = query.filter(\.$active == true)
        }
        return try await query.all()
    }

    // -- get user by id --
    app.get("users", ":id") { req async throws -> User in
        guard let idParam = req.parameters.get("id"),
              let id = Int(idParam) else {
            throw Abort(.badRequest)
        }
        guard let user = try await User.find(id, on: req.db) else {
            throw UserError.notFound(id)
        }
        return user
    }

    // -- create user --
    app.post("users") { req async throws -> Response in
        let input = try req.content.decode(CreateUserRequest.self)
        let role: UserRole = input.userRole
        let user = User(name: input.name, email: input.email, role: role)
        try await user.save(on: req.db)
        return try await user.encodeResponse(status: .created, for: req)
    }

    // -- update user --
    app.put("users", ":id") { req async throws -> User in
        guard let idParam = req.parameters.get("id"),
              let id = Int(idParam) else {
            throw Abort(.badRequest)
        }
        guard let user = try await User.find(id, on: req.db) else {
            throw UserError.notFound(id)
        }
        let updates = try req.content.decode(UpdateUserRequest.self)
        if let name = updates.name { user.name = name }
        if let email = updates.email { user.email = email }
        if let role = updates.role { user.role = role }
        if let active = updates.active { user.active = active }
        try await user.save(on: req.db)
        return user
    }

    // -- delete user --
    app.delete("users", ":id") { req async throws -> HTTPStatus in
        guard let idParam = req.parameters.get("id"),
              let id = Int(idParam) else {
            throw Abort(.badRequest)
        }
        guard let user = try await User.find(id, on: req.db) else {
            throw UserError.notFound(id)
        }
        try await user.delete(on: req.db)
        return .noContent
    }

    // -- health check --
    app.get("health") { _ -> [String: String] in
        return ["status": "ok", "version": apiVersion]
    }
}

@main
struct App {
    static func main() async throws {
        let app = try await Application.make(.detect())
        let config = AppConfig.default
        try await configure(app, config: config)
        try await app.execute()
    }
}
