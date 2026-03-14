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
