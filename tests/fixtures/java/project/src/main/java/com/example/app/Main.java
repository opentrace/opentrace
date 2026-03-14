package com.example.app;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class Main {
    private static UserRepository userRepo;

    public static void main(String[] args) throws Exception {
        userRepo = new UserRepository("jdbc:sqlite:app.db");
        userRepo.initialize();

        HttpServer server = HttpServer.create(new InetSocketAddress(8080), 0);
        server.createContext("/users", Main::handleUsers);
        server.start();
        System.out.println("Server running on port 8080");
    }

    private static void handleUsers(HttpExchange exchange) throws IOException {
        switch (exchange.getRequestMethod()) {
            case "GET":
                listUsers(exchange);
                break;
            case "POST":
                createUser(exchange);
                break;
        }
    }

    private static void listUsers(HttpExchange exchange) throws IOException {
        String json = userRepo.getAllUsersAsJson();
        sendResponse(exchange, 200, json);
    }

    private static void createUser(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String json = userRepo.insertUserFromJson(body);
        sendResponse(exchange, 201, json);
    }

    private static void sendResponse(HttpExchange exchange, int status, String body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
