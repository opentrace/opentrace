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

package com.example.app;

import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class Main {
    // -- constants --
    private static final int DEFAULT_PORT = 8080;
    private static final String DB_URL = "jdbc:sqlite:app.db";
    private static final String CONTENT_TYPE_JSON = "application/json";

    // -- static fields --
    private static UserRepository userRepo;
    private static volatile boolean running = true;
    private static int requestCount = 0;

    public static void main(String[] args) throws Exception {
        int port = args.length > 0 ? Integer.parseInt(args[0]) : DEFAULT_PORT;

        userRepo = new UserRepository(DB_URL);
        userRepo.initialize();

        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/users", Main::handleUsers);
        server.createContext("/health", Main::handleHealth);
        server.start();
        System.out.println("Server running on port " + port);

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            running = false;
            server.stop(5);
            try { userRepo.close(); } catch (Exception ignored) {}
        }));
    }

    private static void handleUsers(HttpExchange exchange) throws IOException {
        requestCount++;
        switch (exchange.getRequestMethod()) {
            case "GET" -> listUsers(exchange);
            case "POST" -> createUser(exchange);
            default -> sendResponse(exchange, 405, "{\"error\":\"method not allowed\"}");
        }
    }

    private static void handleHealth(HttpExchange exchange) throws IOException {
        String json = String.format("{\"status\":\"ok\",\"requests\":%d}", requestCount);
        sendResponse(exchange, 200, json);
    }

    private static void listUsers(HttpExchange exchange) throws IOException {
        try {
            String json = userRepo.getAllUsersAsJson();
            sendResponse(exchange, 200, json);
        } catch (Exception e) {
            String error = "{\"error\":\"" + e.getMessage() + "\"}";
            sendResponse(exchange, 500, error);
        }
    }

    private static void createUser(HttpExchange exchange) throws IOException {
        try {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String json = userRepo.insertUserFromJson(body);
            sendResponse(exchange, 201, json);
        } catch (Exception e) {
            String error = "{\"error\":\"" + e.getMessage() + "\"}";
            sendResponse(exchange, 400, error);
        }
    }

    private static void sendResponse(HttpExchange exchange, int status, String body) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", CONTENT_TYPE_JSON);
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }
}
