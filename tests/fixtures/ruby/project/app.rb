require "sinatra"
require "json"
require_relative "db"

set :port, 8080

db = UserDatabase.new("app.db")
db.initialize_schema

get "/users" do
  content_type :json
  users = db.get_all_users
  users.to_json
end

post "/users" do
  content_type :json
  data = JSON.parse(request.body.read)
  user = db.insert_user(data["name"], data["email"])
  status 201
  user.to_json
end
