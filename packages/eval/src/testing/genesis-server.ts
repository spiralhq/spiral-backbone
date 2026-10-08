import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function startGenesisServer(
  genesis: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const id = (JSON.parse(body) as { id: unknown }).id;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: genesis }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/key-abc`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
