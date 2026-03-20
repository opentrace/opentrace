require "sinatra"
require "json"
require_relative "db"

# -- constants --
DEFAULT_PORT = 8080
API_VERSION = "v1"

# -- module-level state --
set :port, DEFAULT_PORT
db = UserDatabase.new("app.db")
db.initialize_schema
request_count = 0

# -- middleware-like before filter --
before do
  content_type :json
  request_count += 1
end

# -- routes --
get "/users" do
  role = params[:role]
  active_only = params[:active] == "true"
  limit = (params[:limit] || 20).to_i
  offset = (params[:offset] || 0).to_i

  users = db.get_all_users(role: role, active_only: active_only, limit: limit, offset: offset)
  total = db.count_users
  { users: users, total: total, page: (offset / limit) + 1 }.to_json
end

get "/users/:id" do
  user_id = params[:id].to_i
  begin
    user = db.get_user_by_id(user_id)
    user.to_json
  rescue UserNotFoundError => e
    status 404
    { error: e.message }.to_json
  end
end

post "/users" do
  data = JSON.parse(request.body.read)
  name = data["name"]
  email = data["email"]
  role = data.fetch("role", DEFAULT_ROLE)
  user = db.insert_user(name, email, role: role)
  status 201
  user.to_json
end

put "/users/:id" do
  user_id = params[:id].to_i
  data = JSON.parse(request.body.read)
  begin
    updates = data.transform_keys(&:to_sym)
    user = db.update_user(user_id, **updates)
    user.to_json
  rescue UserNotFoundError => e
    status 404
    { error: e.message }.to_json
  end
end

delete "/users/:id" do
  user_id = params[:id].to_i
  deleted = db.delete_user(user_id)
  if deleted
    status 204
    ""
  else
    status 404
    { error: "user not found" }.to_json
  end
end

get "/health" do
  { status: "ok", version: API_VERSION, requests: request_count }.to_json
end
