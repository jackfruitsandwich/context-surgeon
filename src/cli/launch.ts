import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { startProxy } from "../proxy/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadSkillMarkdown(): string {
  try {
    return readFileSync(getSkillPath(), "utf-8");
  } catch {
    console.error("[context-surgeon] Warning: could not load skill.md");
    return "";
  }
}

function getSkillPath(): string {
  return join(__dirname, "..", "..", "skill.md");
}

type Target = "codex" | "claude";

function hasConfigOverride(args: string[], key: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-c" || arg === "--config") && args[i + 1]) {
      if (args[i + 1].trim().startsWith(`${key}=`)) {
        return true;
      }
      i += 1;
      continue;
    }

    if (arg.startsWith("-c") && arg.slice(2).trim().startsWith(`${key}=`)) {
      return true;
    }

    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length).trim();
      if (value.startsWith(`${key}=`)) {
        return true;
      }
    }
  }

  return false;
}

function hasOption(args: string[], shortFlag: string, longFlag: string): boolean {
  return args.some(
    (arg) => arg === shortFlag || arg === longFlag || arg.startsWith(`${longFlag}=`)
  );
}

function userConfigHasTopLevelModelProvider(): boolean {
  try {
    const raw = readFileSync(join(homedir(), ".codex", "config.toml"), "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      if (trimmed.startsWith("[")) {
        return false;
      }
      if (/^model_provider\s*=/.test(trimmed)) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}

async function startConfiguredProxy(): Promise<{
  proxy: Awaited<ReturnType<typeof startProxy>>;
  portFile: string;
}> {
  const skillMarkdown = loadSkillMarkdown();

  const maxTokens = parseInt(
    process.env.CONTEXT_SURGEON_MAX_TOKENS || "128000",
    10
  );

  const upstreamOpenAI =
    process.env.CONTEXT_SURGEON_UPSTREAM_OPENAI ||
    process.env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";

  const upstreamChatGPT =
    process.env.CONTEXT_SURGEON_UPSTREAM_CHATGPT ||
    "https://chatgpt.com/backend-api";

  const upstreamAnthropic =
    process.env.CONTEXT_SURGEON_UPSTREAM_ANTHROPIC ||
    process.env.ANTHROPIC_BASE_URL ||
    "https://api.anthropic.com";

  const proxy = await startProxy({
    skillMarkdown,
    maxTokens,
    upstreamOpenAI,
    upstreamAnthropic,
    upstreamChatGPT,
  });

  const portDir = join(homedir(), ".context-surgeon");
  mkdirSync(portDir, { recursive: true });
  const portFile = join(portDir, "port");
  writeFileSync(portFile, String(proxy.port));

  return { proxy, portFile };
}

/**
 * Cursor mode: Cursor routes BYOK requests through its own backend, so the
 * proxy must be reachable from the public internet. We expose it through a
 * cloudflared quick tunnel and the user pastes the tunnel URL into
 * Cursor → Settings → Models → API Keys → "Override OpenAI Base URL".
 */
export async function launchCursor(extraArgs: string[]): Promise<void> {
  const { proxy, portFile } = await startConfiguredProxy();
  const localBase = `http://127.0.0.1:${proxy.port}/v1`;
  const noTunnel = extraArgs.includes("--no-tunnel");

  function shutdown(code: number): void {
    const summary = proxy.getShutdownDirectiveSummary();
    if (summary) {
      console.error(`\n${summary}`);
    }
    try { unlinkSync(portFile); } catch {}
    proxy.close();
    process.exit(code);
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => shutdown(0));
  }

  if (noTunnel) {
    printCursorInstructions(localBase, false);
    return; // keep running until Ctrl-C (proxy server holds the event loop)
  }

  const { spawn } = await import("node:child_process");
  const tunnel = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://127.0.0.1:${proxy.port}`],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let printed = false;
  const onTunnelOutput = (chunk: Buffer): void => {
    if (printed) return;
    const match = chunk
      .toString("utf-8")
      .match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      printed = true;
      printCursorInstructions(`${match[0]}/v1`, true);
    }
  };
  tunnel.stdout.on("data", onTunnelOutput);
  tunnel.stderr.on("data", onTunnelOutput);

  tunnel.on("error", () => {
    console.error(
      `[context-surgeon] cloudflared not found — install it to expose the proxy publicly:
  brew install cloudflared          (macOS)
  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

Cursor's backend makes the model requests, so it cannot reach localhost directly.
Falling back to local-only mode (works for tools that run on this machine):`
    );
    printCursorInstructions(localBase, false);
  });

  tunnel.on("exit", (code) => {
    if (printed) {
      console.error(`[context-surgeon] Tunnel exited (code ${code ?? 0}), shutting down`);
      shutdown(code ?? 0);
    }
  });

  process.on("exit", () => {
    try { tunnel.kill(); } catch {}
  });
}

function printCursorInstructions(baseUrl: string, isPublic: boolean): void {
  console.error(`
[context-surgeon] Proxy ready for Cursor.

  1. Open Cursor → Settings → Cursor Settings → Models → API Keys
  2. Enable "OpenAI API Key" and paste your OpenAI API key
  3. Enable "Override OpenAI Base URL" and set it to:

       ${baseUrl}

  4. Click "Verify" — Cursor's backend will route model calls through this proxy
  5. Chat away. The agent can run context-surgeon evict/replace/restore/status
     from the integrated terminal.
${isPublic ? "" : `
  NOTE: this URL is local-only. Cursor's backend cannot reach it — install
  cloudflared for a public tunnel, or use this mode for local testing only.
`}
  Ctrl-C to stop.`);
}

export async function launch(
  target: Target,
  extraArgs: string[]
): Promise<void> {
  const { proxy, portFile } = await startConfiguredProxy();

  const childEnv = { ...process.env };
  childEnv.CONTEXT_SURGEON_PORT = String(proxy.port);

  if (target === "codex") {
    const proxyBase = `http://127.0.0.1:${proxy.port}`;
    const shouldUseProxyProvider =
      !extraArgs.includes("--oss") &&
      !process.env.OPENAI_API_KEY &&
      !hasOption(extraArgs, "-p", "--profile") &&
      !hasConfigOverride(extraArgs, "profile") &&
      !hasConfigOverride(extraArgs, "model_provider") &&
      !userConfigHasTopLevelModelProvider();
    const providerId = "context_surgeon_chatgpt";
    const providerArgs = shouldUseProxyProvider
      ? [
          "-c",
          `model_provider="${providerId}"`,
          "-c",
          `model_providers.${providerId}.name="Context Surgeon ChatGPT"`,
          "-c",
          `model_providers.${providerId}.base_url="${proxyBase}/backend-api/codex"`,
          "-c",
          `model_providers.${providerId}.wire_api="responses"`,
          "-c",
          `model_providers.${providerId}.requires_openai_auth=true`,
          "-c",
          `model_providers.${providerId}.supports_websockets=false`,
        ]
      : [];
    extraArgs = [
      "-c",
      `chatgpt_base_url="${proxyBase}/backend-api/"`,
      "-c",
      `openai_base_url="${proxyBase}/backend-api/codex"`,
      ...providerArgs,
      ...extraArgs,
    ];
  } else if (target === "claude") {
    childEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}/anthropic`;
  }

  await launchWrapped(target, extraArgs, childEnv, proxy, portFile);
}

async function launchWrapped(
  target: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  proxy: {
    port: number;
    close: () => void;
    getShutdownDirectiveSummary: () => string | null;
  },
  portFile: string
): Promise<void> {
  const { spawn } = await import("node:child_process");
  let printedShutdownSummary = false;

  console.error(
    `[context-surgeon] Wrapping '${target}' through proxy on port ${proxy.port}`
  );

  const child = spawn(target, args, { env, stdio: "inherit" });

  function printShutdownSummary(): void {
    if (printedShutdownSummary) {
      return;
    }
    printedShutdownSummary = true;

    const summary = proxy.getShutdownDirectiveSummary();
    if (summary) {
      console.error(`\n${summary}`);
    }
  }

  child.on("exit", (code) => {
    printShutdownSummary();
    try { unlinkSync(portFile); } catch {}
    proxy.close();
    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    console.error(`[context-surgeon] Failed to start ${target}: ${err.message}`);
    printShutdownSummary();
    proxy.close();
    process.exit(1);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => child.kill(sig));
  }
}
