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

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton(new UserRepository("Data Source=app.db"));

var app = builder.Build();
var db = app.Services.GetRequiredService<UserRepository>();
db.Initialize();

app.MapGet("/users", async (UserRepository repo) =>
{
    var users = repo.GetAllUsers();
    return Results.Ok(users);
});

app.MapPost("/users", async (CreateUserRequest request, UserRepository repo) =>
{
    var user = repo.InsertUser(request.Name, request.Email);
    return Results.Created($"/users/{user.Id}", user);
});

app.Run("http://localhost:8080");

public record CreateUserRequest(string Name, string Email);
