import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ChildExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type ManagedChild = Readonly<{
  child: ChildProcess;
  exited: Promise<ChildExit>;
  terminate: (signal?: NodeJS.Signals, graceMs?: number) => Promise<ChildExit>;
}>;

type SpawnChild = typeof spawn;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalChildGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  try {
    child.kill(signal);
  } catch {}
}

export function spawnManagedChild(input: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  stdio?: SpawnOptions["stdio"];
  spawnImpl?: SpawnChild;
}): ManagedChild {
  const spawnImpl = input.spawnImpl ?? spawn;
  const child = spawnImpl(input.command, [...input.args], {
    env: input.env,
    stdio: input.stdio ?? "inherit",
    detached: process.platform !== "win32",
  });

  let settle: ((exit: ChildExit) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  let settledExit: ChildExit | null = null;
  const exited = new Promise<ChildExit>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  child.once("error", (error) => reject?.(error));
  child.once("exit", (code, signal) => {
    settledExit = Object.freeze({ code, signal });
    settle?.(settledExit);
  });

  let termination: Promise<ChildExit> | null = null;
  const terminate = (
    signal: NodeJS.Signals = "SIGTERM",
    graceMs = 2_000
  ): Promise<ChildExit> => {
    if (settledExit) return Promise.resolve(settledExit);
    termination ??= (async () => {
      signalChildGroup(child, signal);
      const result = await Promise.race([
        exited.then((exit) => ({ kind: "exit" as const, exit })),
        delay(graceMs).then(() => ({ kind: "timeout" as const })),
      ]);
      if (result.kind === "exit") return result.exit;
      signalChildGroup(child, "SIGKILL");
      return await exited;
    })();
    return termination;
  };

  return Object.freeze({ child, exited, terminate });
}

export type CloseableRuntime = Readonly<{
  close: (options?: { drainTimeoutMs?: number; reason?: string }) => Promise<unknown>;
}>;

export async function runWrappedChild(input: {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  runtime: CloseableRuntime;
  cleanup?: () => void | Promise<void>;
  childGraceMs?: number;
  drainTimeoutMs?: number;
  installSignalHandlers?: boolean;
  onSignal?: (signal: NodeJS.Signals) => void;
}): Promise<number> {
  const managed = spawnManagedChild({
    command: input.command,
    args: input.args,
    env: input.env,
  });
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    shutdownPromise ??= (async () => {
      await input.runtime.close({
        drainTimeoutMs: input.drainTimeoutMs ?? 2_000,
        reason,
      });
      await input.cleanup?.();
    })();
    return shutdownPromise;
  };

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  if (input.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        input.onSignal?.(signal);
        void Promise.allSettled([
          managed.terminate(signal, input.childGraceMs ?? 2_000),
          shutdown(`received ${signal}`),
        ]);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  try {
    const exit = await managed.exited;
    await shutdown("child exited");
    if (exit.code !== null) return exit.code;
    return exit.signal === "SIGINT" ? 130 : exit.signal === "SIGTERM" ? 143 : 1;
  } catch (error) {
    await managed.terminate("SIGTERM", input.childGraceMs ?? 2_000).catch(() => undefined);
    await shutdown("child exec failure");
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}
