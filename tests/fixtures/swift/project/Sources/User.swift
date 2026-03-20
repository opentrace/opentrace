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

import Fluent
import Vapor

// -- enum --
enum UserRole: String, Codable, CaseIterable {
    case user = "user"
    case admin = "admin"
}

// -- protocol --
protocol UserRepresentable {
    var name: String { get }
    var email: String { get }
}

// -- model --
final class User: Model, Content, UserRepresentable {
    static let schema = "users"
    static let defaultRole: UserRole = .user
    private static var instanceCount: Int = 0

    @ID(custom: "id", generatedBy: .database)
    var id: Int?

    @Field(key: "name")
    var name: String

    @Field(key: "email")
    var email: String

    @Field(key: "role")
    var role: String

    @Field(key: "active")
    var active: Bool

    @Timestamp(key: "created_at", on: .create)
    var createdAt: Date?

    // -- computed properties --
    var isAdmin: Bool {
        return role == UserRole.admin.rawValue
    }

    var displayName: String {
        return "\(name) <\(email)>"
    }

    // -- initializers --
    init() {
        User.instanceCount += 1
    }

    init(name: String, email: String, role: UserRole = .user) {
        self.name = name
        self.email = email
        self.role = role.rawValue
        self.active = true
        User.instanceCount += 1
    }

    // -- static methods --
    static func getInstanceCount() -> Int {
        return instanceCount
    }

    // -- instance methods --
    func deactivate() {
        self.active = false
    }

    func updateRole(_ newRole: UserRole) {
        self.role = newRole.rawValue
    }
}

// -- request DTOs --
struct CreateUserRequest: Content {
    let name: String
    let email: String
    var role: String?

    var userRole: UserRole {
        guard let r = role else { return .user }
        return UserRole(rawValue: r) ?? .user
    }
}

struct UpdateUserRequest: Content {
    var name: String?
    var email: String?
    var role: String?
    var active: Bool?
}

// -- custom error --
enum UserError: Error {
    case notFound(Int)
    case duplicateEmail(String)
}

extension UserError: AbortError {
    var status: HTTPResponseStatus {
        switch self {
        case .notFound:
            return .notFound
        case .duplicateEmail:
            return .conflict
        }
    }

    var reason: String {
        switch self {
        case .notFound(let id):
            return "User \(id) not found"
        case .duplicateEmail(let email):
            return "Email \(email) already exists"
        }
    }
}

// -- migration --
struct CreateUser: AsyncMigration {
    func prepare(on database: Database) async throws {
        try await database.schema("users")
            .field("id", .int, .identifier(auto: true))
            .field("name", .string, .required)
            .field("email", .string, .required)
            .field("role", .string, .required, .custom("DEFAULT 'user'"))
            .field("active", .bool, .required, .custom("DEFAULT true"))
            .field("created_at", .datetime)
            .unique(on: "email")
            .create()
    }

    func revert(on database: Database) async throws {
        try await database.schema("users").delete()
    }
}
