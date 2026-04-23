<?php

declare(strict_types=1);
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


namespace App\Database;

use PDO;

class UserDatabase
{
    private PDO $db;

    public function __construct(string $path)
    {
        $this->db = new PDO("sqlite:{$path}");
        $this->db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    }

    public function initializeSchema(): void
    {
        $this->db->exec(
            "CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE
            )"
        );
    }

    public function getAllUsers(): array
    {
        $stmt = $this->db->query("SELECT id, name, email FROM users");
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    public function insertUser(string $name, string $email): array
    {
        $stmt = $this->db->prepare(
            "INSERT INTO users (name, email) VALUES (:name, :email)"
        );
        $stmt->execute([':name' => $name, ':email' => $email]);
        return [
            'id' => (int) $this->db->lastInsertId(),
            'name' => $name,
            'email' => $email,
        ];
    }
}
