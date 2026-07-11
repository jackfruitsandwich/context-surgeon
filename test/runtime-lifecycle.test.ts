import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runWrappedChild,
  spawnManagedChild,
} from "../src/runtime/process-lifecycle.js";
import { startCloudflaredTunnel } from "../src/runtime/tunnel.js";
import { launch } from "../src/cli/launch.js";

const processFixture = new URL("./fixtures/process-child.mjs", import.meta.url).pathname;
const tunnelFixture = new URL("./fixtures/cloudflared-child.mjs", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "context-surgeon-lifecycle-"));
  temporaryDirectories.push(directory);
  return directory;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}`);
}

describe("spawned process lifecycle", () => {
  it("refuses active launch when the B1 exact-dispatch seam is absent", async () => {
    const oldDisable = process.env.CONTEXT_SURGEON_DISABLE_SURGERY;
    const oldBase = process.env.ANTHROPIC_BASE_URL;
    delete process.env.CONTEXT_SURGEON_DISABLE_SURGERY;
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      await expect(launch("claude", [])).rejects.toThrow(/B1 exact-dispatch handler/);
    } finally {
      if (oldDisable === undefined) delete process.env.CONTEXT_SURGEON_DISABLE_SURGERY;
      else process.env.CONTEXT_SURGEON_DISABLE_SURGERY = oldDisable;
      if (oldBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = oldBase;
    }
  });

  it("chooses the explicit kill-switch bypass before starting a proxy", async () => {
    if (process.platform === "win32") return;
    const directory = temporaryDirectory();
    const executable = join(directory, "codex");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(process.execPath, executable);
    const oldPath = process.env.PATH;
    const oldDisable = process.env.CONTEXT_SURGEON_DISABLE_SURGERY;
    const oldExitCode = process.exitCode;
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => lines.push(values.join(" ")));
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    process.env.CONTEXT_SURGEON_DISABLE_SURGERY = "1";
    try {
      await launch("codex", [processFixture, "normal", "0"]);
      expect(lines.join("\n")).toContain("BYPASS — surgery explicitly disabled before launch");
      expect(lines.join("\n")).not.toContain("Model proxy listening");
    } finally {
      process.env.PATH = oldPath;
      if (oldDisable === undefined) delete process.env.CONTEXT_SURGEON_DISABLE_SURGERY;
      else process.env.CONTEXT_SURGEON_DISABLE_SURGERY = oldDisable;
      process.exitCode = oldExitCode;
    }
  });

  it("reports normal child exit and closes runtime exactly once", async () => {
    const close = vi.fn(async () => undefined);
    const cleanup = vi.fn();
    const code = await runWrappedChild({
      command: process.execPath,
      args: [processFixture, "normal", "7"],
      env: process.env,
      runtime: { close },
      cleanup,
      installSignalHandlers: false,
    });
    expect(code).toBe(7);
    expect(close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("handles child exec failure and still coordinates shutdown", async () => {
    const close = vi.fn(async () => undefined);
    await expect(
      runWrappedChild({
        command: join(temporaryDirectory(), "missing-command"),
        args: [],
        env: process.env,
        runtime: { close },
        installSignalHandlers: false,
        childGraceMs: 20,
      })
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "kills a stubborn child and descendant process group after %s",
    async (signal) => {
      if (process.platform === "win32") return;
      const pidPath = join(temporaryDirectory(), "pids.json");
      const managed = spawnManagedChild({
        command: process.execPath,
        args: [processFixture, "stubborn-tree", pidPath],
        env: process.env,
        stdio: "ignore",
      });
      await waitForFile(pidPath);
      const pids = JSON.parse(readFileSync(pidPath, "utf8")) as {
        parent: number;
        descendant: number;
      };
      expect(isAlive(pids.parent)).toBe(true);
      expect(isAlive(pids.descendant)).toBe(true);
      await managed.terminate(signal, 40);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(isAlive(pids.parent)).toBe(false);
      expect(isAlive(pids.descendant)).toBe(false);
    }
  );
});

describe("cloudflared lifecycle", () => {
  it("parses a split startup URL and tears the tunnel down", async () => {
    const handle = await startCloudflaredTunnel({
      modelPort: 4567,
      command: process.execPath,
      commandPrefixArgs: [tunnelFixture, "url"],
      startupTimeoutMs: 1_000,
    });
    expect(handle.publicUrl).toBe("https://split-url.trycloudflare.com");
    const pid = handle.child.pid!;
    await handle.close();
    expect(isAlive(pid)).toBe(false);
  });

  it("rejects early tunnel exit without a local fallback", async () => {
    await expect(
      startCloudflaredTunnel({
        modelPort: 4567,
        command: process.execPath,
        commandPrefixArgs: [tunnelFixture, "exit"],
        startupTimeoutMs: 1_000,
      })
    ).rejects.toThrow(/exited before publishing/);
  });

  it("times out startup and force-kills a stubborn tunnel", async () => {
    if (process.platform === "win32") return;
    const pidPath = join(temporaryDirectory(), "tunnel.pid");
    await expect(
      startCloudflaredTunnel({
        modelPort: 4567,
        command: process.execPath,
        commandPrefixArgs: [tunnelFixture, "silent"],
        startupTimeoutMs: 150,
        env: { ...process.env, FAKE_TUNNEL_PID_PATH: pidPath },
      })
    ).rejects.toThrow(/timed out/);
    await waitForFile(pidPath);
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(isAlive(pid)).toBe(false);
  });
});
