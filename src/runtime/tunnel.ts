import { StringDecoder } from "node:string_decoder";
import type { ChildProcess } from "node:child_process";
import { spawnManagedChild, type ManagedChild } from "./process-lifecycle.js";

export type TunnelHandle = Readonly<{
  publicUrl: string;
  child: ChildProcess;
  close: () => Promise<void>;
}>;

const PUBLIC_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function startCloudflaredTunnel(input: {
  modelPort: number;
  startupTimeoutMs?: number;
  command?: string;
  commandPrefixArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<TunnelHandle> {
  const command = input.command ?? "cloudflared";
  const args = [
    ...(input.commandPrefixArgs ?? []),
    "tunnel",
    "--url",
    `http://127.0.0.1:${input.modelPort}`,
  ];
  const managed: ManagedChild = spawnManagedChild({
    command,
    args,
    env: input.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const decoder = new StringDecoder("utf8");
  let outputWindow = "";

  const publicUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("cloudflared startup timed out before publishing a URL"));
    }, input.startupTimeoutMs ?? 15_000);

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      outputWindow = (outputWindow + decoder.write(chunk)).slice(-2_048);
      const match = outputWindow.match(PUBLIC_URL);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      resolve(match[0]);
    };
    managed.child.stdout?.on("data", onData);
    managed.child.stderr?.on("data", onData);
    managed.exited.then(
      (exit) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `cloudflared exited before publishing a URL (code=${exit.code ?? "null"}, signal=${exit.signal ?? "none"})`
          )
        );
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  }).catch(async (error) => {
    await managed.terminate("SIGTERM", 500).catch(() => undefined);
    throw error;
  });

  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    publicUrl,
    child: managed.child,
    close: () => {
      closePromise ??= managed.terminate("SIGTERM", 1_000).then(() => undefined);
      return closePromise;
    },
  });
}
