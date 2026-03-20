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

import express, { Request, Response, NextFunction } from "express";
import { Database, Role, UserNotFoundError } from "./db";
import type { UserFilter } from "./db";

// -- constants --
const DEFAULT_PORT = 8080;
const API_VERSION = "v1" as const;
const MAX_BODY_SIZE = "1mb";

// -- config interface --
interface ServerConfig {
  readonly port: number;
  readonly dbPath: string;
  readonly debug: boolean;
}

// -- module-level state --
const app = express();
let requestCount = 0;

const config: ServerConfig = {
  port: Number(process.env.PORT) || DEFAULT_PORT,
  dbPath: process.env.DB_PATH ?? "app.db",
  debug: process.env.DEBUG === "true",
};

const db = new Database(config.dbPath);

// -- middleware --
app.use(express.json({ limit: MAX_BODY_SIZE }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  requestCount++;
  if (config.debug) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  }
  next();
});

// -- route handlers --
app.get("/users", async (req: Request, res: Response) => {
  const filter: UserFilter = {};

  const roleParam = req.query.role as string | undefined;
  if (roleParam && Object.values(Role).includes(roleParam as Role)) {
    filter.role = roleParam as Role;
  }
  if (req.query.active === "true") {
    filter.activeOnly = true;
  }

  const limitParam = req.query.limit as string | undefined;
  if (limitParam) {
    const parsed: number = parseInt(limitParam, 10);
    if (!isNaN(parsed)) filter.limit = parsed;
  }

  const users = db.getAllUsers(filter);
  const total: number = db.countUsers();
  res.json({ users, total, page: 1 });
});

app.get("/users/:id", (req: Request, res: Response) => {
  const id: number = parseInt(req.params.id, 10);
  try {
    const user = db.getUserById(id);
    res.json(user);
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      throw err;
    }
  }
});

app.post("/users", async (req: Request, res: Response) => {
  const { name, email, role } = req.body as { name: string; email: string; role?: Role };
  const user = db.insertUser({ name, email, role });
  res.status(201).json(user);
});

app.put("/users/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const updates = req.body as Partial<{ name: string; email: string; role: Role }>;
  try {
    const user = db.updateUser(id, updates);
    res.json(user);
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      throw err;
    }
  }
});

app.delete("/users/:id", (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const deleted: boolean = db.deleteUser(id);
  if (!deleted) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.status(204).end();
});

app.get("/health", (_req: Request, res: Response) => {
  const status = { ok: true, requests: requestCount, version: API_VERSION };
  res.json(status);
});

// -- startup --
async function main(): Promise<void> {
  await db.initialize();

  const server = app.listen(config.port, () => {
    console.log(`Server ${API_VERSION} listening on port ${config.port}`);
  });

  // graceful shutdown
  const shutdown = (signal: string): void => {
    console.log(`Received ${signal}, shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
