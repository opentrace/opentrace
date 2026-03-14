require "sqlite3"

class UserDatabase
  def initialize(path)
    @db = SQLite3::Database.new(path)
    @db.results_as_hash = true
  end

  def initialize_schema
    @db.execute(<<~SQL)
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE
      )
    SQL
  end

  def get_all_users
    @db.execute("SELECT id, name, email FROM users")
  end

  def insert_user(name, email)
    @db.execute("INSERT INTO users (name, email) VALUES (?, ?)", [name, email])
    id = @db.last_insert_row_id
    { "id" => id, "name" => name, "email" => email }
  end
end
