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

function greet(name: string): string {
  return `Hello ${name}`;
}
export function helper(): void {}
async function fetchData(url: string): Promise<Response> {
  const resp = await fetch(url);
  return resp.json();
}
function getItems(): string[] {
  return [];
}
function findUser(id: number): User | null {
  return null;
}
function noReturnType(x: number) {
  console.log(x);
}
