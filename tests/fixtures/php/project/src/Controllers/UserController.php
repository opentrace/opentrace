<?php

declare(strict_types=1);

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
