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
