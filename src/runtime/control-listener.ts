import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import http from "node:http";
import { dirname } from "node:path";
import type { RuntimeGuarantee } from "./guarantee.js";

export type ControlPlaneHandle = Readonly<{
  address: string;
  childEnvironment: Readonly<NodeJS.ProcessEnv>;
  close: () => Promise<void>;
}>;

export type ControlPlaneBootstrapInput = Readonly<{
  sessionId: string;
  guarantee: RuntimeGuarantee;
}>;

/** Implemented by B2, which owns capability authentication and state. */
export type ControlPlaneBootstrap = (
  input: ControlPlaneBootstrapInput
) => Promise<ControlPlaneHandle>;

export type AuthenticatedControlRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => void | Promise<void>;

export type UnixControlListener = Readonly<{
  address: string;
  server: http.Server;
  close: () => Promise<void>;
}>;

/**
 * Listener/lifecycle primitive only. The supplied handler must authenticate
 * the per-session capability before serving any endpoint; B3 deliberately
 * does not define or wrap B2's authentication semantics.
 */
export async function startUnixControlListener(input: {
  socketPath: string;
  authenticatedHandler: AuthenticatedControlRequestHandler;
}): Promise<UnixControlListener> {
  if (process.platform === "win32") {
    throw new Error("Unix-domain control sockets are unavailable on Windows");
  }

  const socketDirectory = dirname(input.socketPath);
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  chmodSync(socketDirectory, 0o700);
  const server = http.createServer((req, res) => {
    Promise.resolve(input.authenticatedHandler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      if (!res.writableEnded) res.end('{"error":"control handler failed"}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(input.socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  chmodSync(input.socketPath, 0o600);

  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    address: input.socketPath,
    server,
    close: () => {
      closePromise ??= new Promise<void>((resolve) => {
        server.close(() => {
          try {
            unlinkSync(input.socketPath);
          } catch {}
          resolve();
        });
      });
      return closePromise;
    },
  });
}
