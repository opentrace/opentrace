function greet(name: string): string {
  return `Hello ${name}`;
}
export function helper(): void {}
async function fetchData(url: string): Promise<Response> {
  const resp = await fetch(url);
  return resp.json();
}
