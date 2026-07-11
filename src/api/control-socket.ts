import http from "node:http";
import { chmodSync, lstatSync } from "node:fs";
import { handleControl, type V2ControlContext } from "./control.js";

export type ControlSocketServer = Readonly<{
  server: http.Server;
  socketPath: string;
  close(): Promise<void>;
}>;

/**
 * Binds a mode-0600 Unix control socket. The caller must already own the
 * session lock; this function never unlinks an existing path to steal it.
 */
export async function startControlSocket(
  socketPath: string,
  context: V2ControlContext
): Promise<ControlSocketServer> {
  const server = http.createServer((req, res) => {
    handleControl(req, res, context).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  chmodSync(socketPath, 0o600);
  const mode = lstatSync(socketPath).mode & 0o777;
  if (mode !== 0o600) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`Control socket permissions are ${mode.toString(8)}, expected 600`);
  }
  return Object.freeze({
    server,
    socketPath,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  });
}
