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

func configure(_ app: Application) async throws {
    app.databases.use(.sqlite(.file("app.db")), as: .sqlite)
    app.migrations.add(CreateUser())

    try await app.autoMigrate()

    app.get("users") { req async throws -> [User] in
        try await User.query(on: req.db).all()
    }

    app.post("users") { req async throws -> Response in
        let input = try req.content.decode(CreateUserRequest.self)
        let user = User(name: input.name, email: input.email)
        try await user.save(on: req.db)
        return try await user.encodeResponse(status: .created, for: req)
    }
}

@main
struct App {
    static func main() async throws {
        let app = try await Application.make(.detect())
        try await configure(app)
        try await app.execute()
    }
}
