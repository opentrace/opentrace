<?php

declare(strict_types=1);

require __DIR__ . '/../vendor/autoload.php';

use App\Controllers\UserController;
use App\Database\UserDatabase;
use Slim\Factory\AppFactory;

$db = new UserDatabase(__DIR__ . '/../app.db');
$db->initializeSchema();

$controller = new UserController($db);

$app = AppFactory::create();

$app->get('/users', [$controller, 'listUsers']);
$app->post('/users', [$controller, 'createUser']);

$app->run();
