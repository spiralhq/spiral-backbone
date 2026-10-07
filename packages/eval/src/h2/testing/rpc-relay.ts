import { connect, createServer, type AddressInfo } from "node:net";

export const HOST_GATEWAY_ADD_HOST = "host.docker.internal:host-gateway";

/** Surfpool binds 127.0.0.1 only; containers reach this 0.0.0.0 relay via host.docker.internal. */
export async function startRpcRelay(
  targetUrl: string,
): Promise<{ port: number; urlForContainers: string; stop(): Promise<void> }> {
  const target = new URL(targetUrl);
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    urlForContainers: `http://host.docker.internal:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
