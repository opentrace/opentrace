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
