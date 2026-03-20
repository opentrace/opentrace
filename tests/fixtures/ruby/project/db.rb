require "sqlite3"

# -- constants --
TABLE_NAME = "users"
DEFAULT_ROLE = "user"
MAX_PAGE_SIZE = 100

# -- custom errors --
class UserNotFoundError < StandardError
  attr_reader :user_id

  def initialize(user_id)
    @user_id = user_id
    super("User #{user_id} not found")
  end
end

# -- main class --
class UserDatabase
  attr_reader :path

  # class-level state
  @@instance_count = 0

  def initialize(path)
    @path = path
    @db = SQLite3::Database.new(path)
    @db.results_as_hash = true
    @read_only = false
    @@instance_count += 1
  end

  def self.instance_count
    @@instance_count
  end

  def initialize_schema
    @db.execute(<<~SQL)
      CREATE TABLE IF NOT EXISTS #{TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL DEFAULT '#{DEFAULT_ROLE}',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    SQL
  end

  # -- CRUD with various parameter patterns --
  def get_all_users(role: nil, active_only: false, limit: MAX_PAGE_SIZE, offset: 0)
    query = "SELECT id, name, email, role, active FROM #{TABLE_NAME} WHERE 1=1"
    params = []

    if role
      query += " AND role = ?"
      params << role
    end

    if active_only
      query += " AND active = 1"
    end

    effective_limit = [limit, MAX_PAGE_SIZE].min
    query += " LIMIT ? OFFSET ?"
    params << effective_limit << offset

    @db.execute(query, params)
  end

  def get_user_by_id(user_id)
    result = @db.execute(
      "SELECT id, name, email, role, active FROM #{TABLE_NAME} WHERE id = ?",
      [user_id]
    )
    raise UserNotFoundError.new(user_id) if result.empty?
    result.first
  end

  def insert_user(name, email, role: DEFAULT_ROLE)
    @db.execute(
      "INSERT INTO #{TABLE_NAME} (name, email, role) VALUES (?, ?, ?)",
      [name, email, role]
    )
    new_id = @db.last_insert_row_id
    { "id" => new_id, "name" => name, "email" => email, "role" => role }
  end

  def update_user(user_id, **fields)
    get_user_by_id(user_id) # raises if not found

    allowed = %w[name email role active]
    updates = fields.select { |k, _| allowed.include?(k.to_s) }
    return get_user_by_id(user_id) if updates.empty?

    set_clause = updates.keys.map { |k| "#{k} = ?" }.join(", ")
    values = updates.values + [user_id]
    @db.execute("UPDATE #{TABLE_NAME} SET #{set_clause} WHERE id = ?", values)
    get_user_by_id(user_id)
  end

  def delete_user(user_id)
    @db.execute("DELETE FROM #{TABLE_NAME} WHERE id = ?", [user_id])
    @db.changes > 0
  end

  def count_users(role: nil)
    if role
      result = @db.execute("SELECT COUNT(*) as cnt FROM #{TABLE_NAME} WHERE role = ?", [role])
    else
      result = @db.execute("SELECT COUNT(*) as cnt FROM #{TABLE_NAME}")
    end
    result.first["cnt"]
  end

  def close
    @db.close
  end

  private

  def read_only?
    @read_only
  end
end
