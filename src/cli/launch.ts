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

export async function launch(
  target: Target,
  extraArgs: string[]
): Promise<void> {
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

  // Write port to a well-known file so CLI commands can find it
  const portDir = join(homedir(), ".context-surgeon");
  mkdirSync(portDir, { recursive: true });
  const portFile = join(portDir, "port");
  writeFileSync(portFile, String(proxy.port));

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
