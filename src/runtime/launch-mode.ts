import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ModelTrafficPolicy, TrafficMode } from "./traffic-policy.js";
import { policyForMode } from "./traffic-policy.js";

export type CodexAuthMode = "chatgpt" | "api-key" | "unknown";

export type CodexLaunchPlan =
  | Readonly<{
      supported: true;
      mode: "subscription" | "api-key";
      trafficMode: Extract<TrafficMode, "codex-subscription" | "codex-api-key">;
      authClass: "native-chatgpt" | "openai-api-key";
      upstreamClass: "chatgpt-subscription" | "openai-api";
      providerArgs: readonly string[];
      trafficPolicy: ModelTrafficPolicy;
    }>
  | Readonly<{
      supported: false;
      mode: "profile" | "custom-provider" | "custom-base-url" | "remote" | "oss" | "auth-unknown";
      reason: string;
    }>;

type ConfigOverrides = Readonly<Record<string, string>>;

const CODEX_TOP_LEVEL_COMMANDS = new Set([
  "exec",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "resume",
  "archive",
  "delete",
  "unarchive",
  "fork",
  "cloud",
  "exec-server",
  "features",
]);

const CODEX_OPTIONS_WITH_VALUES = new Set([
  "-c",
  "--config",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);

function commandIndex(
  args: readonly string[],
  start: number,
  commands: ReadonlySet<string>
): number | null {
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return null;
    if (CODEX_OPTIONS_WITH_VALUES.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return commands.has(argument) ? index : null;
  }
  return null;
}

/**
 * Codex subcommands own a separate `-c` scope. Provider overrides placed before
 * `exec`, `review`, `resume`, etc. are accepted by the parent parser but do not
 * select the provider used by that subcommand. Put the overrides inside the
 * deepest model-running command scope; interactive launches keep them at the
 * top level.
 */
export function injectCodexProviderArgs(
  args: readonly string[],
  providerArgs: readonly string[]
): string[] {
  const topLevel = commandIndex(args, 0, CODEX_TOP_LEVEL_COMMANDS);
  if (topLevel === null) return [...providerArgs, ...args];

  // Repeated `-c` values are last-one-wins. Put the generated provider values
  // at the end of the selected subcommand's option scope, but before an
  // explicit `--` option terminator.
  const terminator = args.indexOf("--", topLevel + 1);
  const insertionIndex = terminator === -1 ? args.length : terminator;
  return [
    ...args.slice(0, insertionIndex),
    ...providerArgs,
    ...args.slice(insertionIndex),
  ];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseConfigOverrides(args: readonly string[]): ConfigOverrides {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    let assignment: string | undefined;
    const arg = args[index];
    if (arg === "-c" || arg === "--config") {
      assignment = args[index + 1];
      index += 1;
    } else if (arg.startsWith("-c") && arg.length > 2) {
      assignment = arg.slice(2);
    } else if (arg.startsWith("--config=")) {
      assignment = arg.slice("--config=".length);
    }
    if (!assignment) continue;
    const equals = assignment.indexOf("=");
    if (equals <= 0) continue;
    result[assignment.slice(0, equals).trim()] = unquote(assignment.slice(equals + 1));
  }
  return Object.freeze(result);
}

export function parseTopLevelCodexConfig(raw: string): ConfigOverrides {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+#.*$/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    result[trimmed.slice(0, equals).trim()] = unquote(trimmed.slice(equals + 1));
  }
  return Object.freeze(result);
}

export function readUserCodexConfig(env: NodeJS.ProcessEnv = process.env): ConfigOverrides {
  const codexHome = env.CODEX_HOME || join(homedir(), ".codex");
  try {
    return parseTopLevelCodexConfig(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return Object.freeze({});
  }
}

function hasOption(args: readonly string[], short: string, long: string): boolean {
  return args.some(
    (arg) =>
      arg === short ||
      arg === long ||
      arg.startsWith(`${long}=`) ||
      (arg.startsWith(short) && arg.length > short.length)
  );
}

function hasLongOption(args: readonly string[], long: string): boolean {
  return args.some((arg) => arg === long || arg.startsWith(`${long}=`));
}

function optionValue(args: readonly string[], short: string, long: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === short || arg === long) return args[index + 1];
    if (arg.startsWith(`${long}=`)) return arg.slice(long.length + 1);
    if (arg.startsWith(short) && arg.length > short.length) return arg.slice(short.length);
  }
  return undefined;
}

export function probeCodexAuthMode(command = "codex"): CodexAuthMode {
  const result = spawnSync(command, ["login", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (result.status !== 0 || result.error) return "unknown";
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (/using\s+chatgpt/i.test(output)) return "chatgpt";
  if (/using\s+(?:an\s+)?api key/i.test(output)) return "api-key";
  return "unknown";
}

export function classifyCodexLaunch(input: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  authMode: CodexAuthMode;
  userConfig?: ConfigOverrides;
  proxyBase: string;
}): CodexLaunchPlan {
  const overrides = parseConfigOverrides(input.args);
  const userConfig: ConfigOverrides = input.userConfig ?? Object.freeze({});
  if (input.args.includes("--oss")) {
    return { supported: false, mode: "oss", reason: "Codex OSS mode uses a local backend and is not redirected" };
  }
  if (hasLongOption(input.args, "--local-provider")) {
    return {
      supported: false,
      mode: "oss",
      reason: "A Codex local provider uses a backend that is not redirected",
    };
  }
  if (
    hasLongOption(input.args, "--remote") ||
    hasLongOption(input.args, "--remote-auth-token-env")
  ) {
    return {
      supported: false,
      mode: "remote",
      reason: "Codex remote mode bypasses the local model-request provider",
    };
  }

  const profile = optionValue(input.args, "-p", "--profile") || overrides.profile || userConfig.profile;
  if (profile || hasOption(input.args, "-p", "--profile")) {
    return {
      supported: false,
      mode: "profile",
      reason: `Codex profile${profile ? ` '${profile}'` : ""} may select an unknown provider; surgery is not active`,
    };
  }

  const explicitProvider = Object.prototype.hasOwnProperty.call(overrides, "model_provider");
  const providerDefinition = Object.keys(overrides).find(
    (key) => key === "model_providers" || key.startsWith("model_providers.")
  );
  if (explicitProvider || providerDefinition) {
    return {
      supported: false,
      mode: "custom-provider",
      reason: providerDefinition
        ? `Codex provider override '${providerDefinition}' could replace Context Surgeon's loopback route`
        : "An explicit Codex model_provider override could replace Context Surgeon's provider after injection",
    };
  }

  const provider = userConfig.model_provider;
  if (provider && provider !== "openai") {
    return {
      supported: false,
      mode: "custom-provider",
      reason: `Codex model provider '${provider}' is custom or unsupported; surgery is not active`,
    };
  }

  const customBase =
    overrides.openai_base_url ||
    overrides.chatgpt_base_url ||
    userConfig.openai_base_url ||
    userConfig.chatgpt_base_url ||
    input.env.OPENAI_BASE_URL;
  if (customBase) {
    return {
      supported: false,
      mode: "custom-base-url",
      reason: "A Codex/OpenAI base URL override is already configured; refusing to replace a custom backend",
    };
  }

  const forcedLogin = overrides.forced_login_method || userConfig.forced_login_method;
  const apiKeyEnvironment = input.env.OPENAI_API_KEY
    ? "OPENAI_API_KEY"
    : input.env.CODEX_API_KEY && input.args.includes("exec")
      ? "CODEX_API_KEY"
      : null;
  let mode = input.authMode;
  if (forcedLogin === "chatgpt") mode = "chatgpt";
  if (forcedLogin === "api") mode = "api-key";
  if (apiKeyEnvironment) mode = "api-key";

  if (mode === "unknown") {
    return {
      supported: false,
      mode: "auth-unknown",
      reason: "Could not positively identify Codex authentication with 'codex login status'",
    };
  }

  const subscription = mode === "chatgpt";
  const providerId = subscription
    ? "context_surgeon_chatgpt"
    : "context_surgeon_openai_api";
  const baseUrl = subscription
    ? `${input.proxyBase}/backend-api/codex`
    : `${input.proxyBase}/v1`;
  const providerArgs = [
    "-c",
    `model_provider="${providerId}"`,
    "-c",
    `model_providers.${providerId}.name="Context Surgeon ${subscription ? "ChatGPT" : "OpenAI API"}"`,
    "-c",
    `model_providers.${providerId}.base_url="${baseUrl}"`,
    "-c",
    `model_providers.${providerId}.wire_api="responses"`,
    "-c",
    `model_providers.${providerId}.supports_websockets=false`,
  ];
  if (!subscription && apiKeyEnvironment) {
    providerArgs.push("-c", `model_providers.${providerId}.env_key="${apiKeyEnvironment}"`);
  } else {
    providerArgs.push("-c", `model_providers.${providerId}.requires_openai_auth=true`);
  }

  const trafficMode = subscription ? "codex-subscription" : "codex-api-key";
  return Object.freeze({
    supported: true,
    mode: subscription ? "subscription" : "api-key",
    trafficMode,
    authClass: subscription ? "native-chatgpt" : "openai-api-key",
    upstreamClass: subscription ? "chatgpt-subscription" : "openai-api",
    providerArgs: Object.freeze(providerArgs),
    trafficPolicy: policyForMode(trafficMode),
  });
}
