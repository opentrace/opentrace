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

import express, { Request, Response } from "express";
import { Database } from "./db";

const app = express();
app.use(express.json());

const db = new Database("app.db");

app.get("/users", async (req: Request, res: Response) => {
  const users = await db.getAllUsers();
  res.json(users);
});

app.post("/users", async (req: Request, res: Response) => {
  const { name, email } = req.body;
  const user = await db.insertUser(name, email);
  res.status(201).json(user);
});

async function main() {
  await db.initialize();
  app.listen(8080, () => {
    console.log("Server running on port 8080");
  });
}

main();
