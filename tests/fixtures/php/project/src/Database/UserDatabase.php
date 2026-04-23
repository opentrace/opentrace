<?php

declare(strict_types=1);

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
