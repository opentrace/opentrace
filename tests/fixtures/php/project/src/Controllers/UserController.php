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


namespace App\Controllers;

use App\Database\UserDatabase;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;

class UserController
{
    private UserDatabase $db;

    public function __construct(UserDatabase $db)
    {
        $this->db = $db;
    }

    public function listUsers(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $users = $this->db->getAllUsers();
        $response->getBody()->write((string) json_encode($users));
        return $response->withHeader('Content-Type', 'application/json');
    }

    public function createUser(ServerRequestInterface $request, ResponseInterface $response): ResponseInterface
    {
        $data = (array) $request->getParsedBody();
        $user = $this->db->insertUser($data['name'] ?? '', $data['email'] ?? '');
        $response->getBody()->write((string) json_encode($user));
        return $response
            ->withStatus(201)
            ->withHeader('Content-Type', 'application/json');
    }
}
